const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// CRITICAL STARTUP VALIDATION (Fail Fast)
// ==========================================
const requiredEnv = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_S3_BUCKET_NAME'
];

const missingEnv = requiredEnv.filter(env => !process.env[env]);
if (missingEnv.length > 0) {
    console.error(`[CRITICAL CONFIG ERROR] Missing required environment variables: ${missingEnv.join(', ')}`);
}

// ==========================================
// MIDDLEWARE CONFIGURATION
// ==========================================
const allowedOrigins = [
    'https://www.worldmotormarket.com',
    'https://worldmotormarket.com',
    'https://www.theworldmotormarket.com',
    'https://theworldmotormarket.com',
    'https://twmm-seven.vercel.app'
];

// Explicit Preflight Short-Circuit & Request Debugger
app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    // Debug incoming request context for terminal tracking
    console.log(`[INCOMING REQ] Method: ${req.method} | Path: ${req.path} | Origin: ${origin || 'None (Server-to-Server)'}`);

    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, listing-id, listing-tag, user-email');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        console.log(`[CORS PREFLIGHT SUCCESS] Handled OPTIONS for ${req.path}`);
        return res.status(200).end();
    }
    next();
});

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.error(`[CORS BLOCKED ERROR] Origin "${origin}" was blocked by CORS configuration.`);
            callback(new Error(`Not allowed by CORS: ${origin}`));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'listing-id', 'listing-tag', 'user-email'],
    credentials: true
};

app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static frontend assets from a "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// Clean URL middleware for subpages (e.g., /about -> /about.html)
app.get('/:page', (req, res, next) => {
    const page = req.params.page;
    const filePath = path.join(__dirname, 'public', `${page}.html`);
    
    res.sendFile(filePath, (err) => {
        if (err) {
            next(); // If the file doesn't exist, move on to other routes or 404
        }
    });
});

// Keep uploads in memory temporarily to stream to S3
const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// CLIENT INITIALIZATIONS
// ==========================================
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// ==========================================
// 1. IMAGE UPLOAD ROUTE (AWS S3)
// ==========================================
app.post('/upload', (req, res, next) => {
    // Wrap multer inside a custom middleware to catch binary multipart parsing crashes
    upload.array('images', 5)(req, res, (err) => {
        if (err) {
            console.error('[CRITICAL MULTER ERROR]', err);
            return res.status(400).json({ success: false, error: `File upload parsing failed: ${err.message}` });
        }
        next();
    });
}, async (req, res) => {
    const listingId = req.headers['listing-id'];
    const listingTag = req.headers['listing-tag'];

    if (!listingId) {
        console.error('[VALIDATION ERROR] /upload called without listing-id header.');
        return res.status(400).json({ success: false, error: 'Missing listing-id header.' });
    }

    try {
        if (!req.files || req.files.length === 0) {
            console.error('[VALIDATION ERROR] /upload called with zero files.');
            return res.status(400).json({ success: false, error: 'No images provided.' });
        }

        const uploadedImageUrls = [];

        for (const [index, file] of req.files.entries()) {
            const fileExtension = file.originalname.split('.').pop();
            const fileName = `listings/${listingId}/image_${index + 1}_${Date.now()}.${fileExtension}`;
            
            const uploadParams = {
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Key: fileName,
                Body: file.buffer,
                ContentType: file.mimetype
            };

            await s3Client.send(new PutObjectCommand(uploadParams));

            const fileUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
            uploadedImageUrls.push(fileUrl);
        }

        return res.status(200).json({ success: true, urls: uploadedImageUrls });
    } catch (err) {
        console.error('[CRITICAL AWS S3 ERROR]', {
            message: err.message,
            code: err.name,
            stack: err.stack,
            bucket: process.env.AWS_S3_BUCKET_NAME
        });
        return res.status(500).json({ success: false, error: `Image upload failed: ${err.message}` });
    }
});

// ==========================================
// 2. UNIFIED LISTINGS SUBMISSION ROUTE
// ==========================================
app.post('/api/listings', async (req, res) => {
    const payload = req.body;
    
    try {
        let dbRecord = {};

        if (payload.vehicle) {
            dbRecord = {
                unique_listing_id: payload.id?.uniqueListingID,
                category: 'vehicle',
                status: 'incoming',
                title: payload.title,
                description: payload.vehicle.description,
                image_urls: payload.images,
                asking_price: payload.vehicle.askingPrice,
                negotiate: payload.vehicle.negotiate,
                plus_minus: payload.vehicle.plusMinus,
                fulfillment: payload.vehicle.fulfillment,
                vehicle_type: payload.vehicle.category,
                make: payload.vehicle.make,
                model: payload.vehicle.model,
                trim: payload.vehicle.trim,
                year: payload.vehicle.year ? parseInt(payload.vehicle.year) : null,
                theme: payload.vehicle.theme,
                vin: payload.vehicle.vin,
                condition: payload.vehicle.condition,
                mileage: payload.vehicle.mileage,
                fuel: payload.vehicle.fuel,
                drive_type: payload.vehicle.driveType,
                transmission: payload.vehicle.transmission,
                fuel_efficiency: payload.vehicle.fuelEfficiency,
                exterior_color: payload.vehicle.exteriorColor,
                interior_color: payload.vehicle.interiorColor,
                performance_upgrades: payload.vehicle.performanceUpgrades,
                aesthetic_upgrades: payload.vehicle.aestheticUpgrades,
                engine_type: payload.vehicle.engineType,
                horsepower: payload.vehicle.horsepower,
                suspension: payload.vehicle.suspension,
                tires: payload.vehicle.tires,
                contact_name: payload.contact?.name,
                contact_address: payload.contact?.address,
                contact_city: payload.contact?.city,
                contact_state: payload.contact?.state,
                contact_zip_code: payload.contact?.zipCode,
                contact_phone: payload.contact?.phone,
                contact_email: payload.contact?.email,
                auth_username: payload.auth?.username,
                auth_password: payload.auth?.password,
                legal_listing_choice: payload.auth?.legalListingChoice
            };
        } else if (payload.part) {
            dbRecord = {
                unique_listing_id: payload.id?.uniquePartListingID,
                category: 'part',
                status: 'incoming',
                title: payload.title,
                description: payload.description,
                image_urls: payload.images,
                asking_price: payload.price?.askingPrice,
                negotiate: payload.price?.negotiate,
                plus_minus: payload.price?.plusMinus,
                fulfillment: payload.price?.fulfillment,
                part_name: payload.part.partName,
                part_category: payload.part.category,
                part_type: payload.part.partType,
                part_brand: payload.part.partBrand,
                part_model: payload.part.partModel,
                part_year: payload.part.partYear,
                compat_vehicle_type: payload.compatibility?.vehicleType,
                compat_make: payload.compatibility?.make,
                compat_model: payload.compatibility?.model,
                compat_trim: payload.compatibility?.trim,
                compat_from_year: payload.compatibility?.fromYear,
                compat_to_year: payload.compatibility?.toYear,
                part_availability: payload.partInfo?.availability,
                part_size: payload.partInfo?.size,
                part_compatibility: payload.partInfo?.partCompatibility,
                part_number: payload.partInfo?.partNumber,
                warranty: payload.partInfo?.warranty,
                material: payload.partInfo?.material,
                dimensions: payload.partInfo?.dimensions,
                weight: payload.partInfo?.weight,
                color: payload.partInfo?.color,
                finish: payload.partInfo?.finish,
                power_source: payload.partInfo?.powerSource,
                contact_name: payload.contact?.name,
                contact_address: payload.contact?.address,
                contact_city: payload.contact?.city,
                contact_state: payload.contact?.state,
                contact_zip_code: payload.contact?.zipCode,
                contact_phone: payload.contact?.phone,
                contact_email: payload.contact?.email,
                auth_username: payload.auth?.username,
                auth_password: payload.auth?.password,
                legal_listing_choice: payload.auth?.legalListingChoice
            };
        } else if (payload.service) {
            dbRecord = {
                unique_listing_id: payload.id?.uniqueServiceListingID,
                category: 'service',
                status: 'incoming',
                title: payload.title,
                description: payload.description,
                image_urls: payload.images,
                service_url: payload.url,
                service_category: payload.service?.category,
                service_type: payload.service?.type,
                custom_service_type: payload.service?.customType,
                company_name: payload.service?.companyName,
                service_address: payload.service?.serviceAddress,
                service_city: payload.service?.city,
                service_state: payload.service?.state,
                service_zip: payload.service?.zipCode,
                hours_monday: payload.openHours?.monday,
                hours_tuesday: payload.openHours?.tuesday,
                hours_wednesday: payload.openHours?.wednesday,
                hours_thursday: payload.openHours?.thursday,
                hours_friday: payload.openHours?.friday,
                hours_saturday: payload.openHours?.saturday,
                hours_sunday: payload.openHours?.sunday,
                service_row_title: payload.service_row?.service_title,
                service_row_description: payload.service_row?.service_description,
                service_row_parts_included: payload.service_row?.service_parts_included,
                service_row_labor_included: payload.service_row?.service_labor_included,
                service_row_price: payload.service_row?.service_price,
                service_row_duration: payload.service_row?.service_duration,
                contact_name: payload.contact?.name,
                contact_phone: payload.contact?.phone,
                contact_email: payload.contact?.email,
                auth_username: payload.auth?.username,
                auth_password: payload.auth?.password,
                legal_listing_choice: payload.auth?.legalListingChoice
            };
        } else {
            console.error('[VALIDATION ERROR] /api/listings payload category unknown:', Object.keys(payload));
            return res.status(400).json({ success: false, error: 'Unknown payload structure category.' });
        }

        if (!dbRecord.unique_listing_id) {
            console.error('[VALIDATION ERROR] Missing unique listing ID inside structured payload map.');
            return res.status(400).json({ success: false, error: 'Missing unique listing ID in payload.' });
        }

        // Upsert record into Supabase
        const { error } = await supabase
            .from('listings')
            .upsert(dbRecord, { onConflict: 'unique_listing_id' });

        if (error) {
            throw error; // Caught by outer try/catch block
        }

        return res.status(200).json({ success: true, message: 'Listing successfully received and stored as incoming.' });
    } catch (err) {
        console.error('[CRITICAL SUPABASE UPSERT ERROR]', {
            message: err.message,
            details: err.details,
            hint: err.hint,
            code: err.code
        });
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// GLOBAL UNCAUGHT ERROR CATCHER
// ==========================================
app.use((err, req, res, next) => {
    console.error('[CRITICAL UNHANDLED EXPRESS ERROR]', err.stack);
    res.status(500).json({ success: false, error: 'Internal Server Error. Check server logs.' });
});

app.listen(port, () => {
    console.log(`Server running smoothly on port ${port}`);
});
