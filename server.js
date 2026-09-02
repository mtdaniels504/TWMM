const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const sanitizeHtml = require('sanitize-html');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const port = process.env.PORT || 3000;

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

const corsOptions = {
    origin: function (origin, callback) {
        console.log(`[CORS Check] Incoming request origin: "${origin}"`);
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            console.log(`[CORS Check] Allowed origin: ${origin || 'No Origin (Server-to-Server/Postman)'}`);
            callback(null, true);
        } else {
            console.warn(`[CORS Check] BLOCKED unauthorized origin: "${origin}"`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'listing-id', 'listing-tag', 'user-email', 'x-admin-secret'],
    credentials: true
};

// Explicitly handle preflight OPTIONS requests for all routes
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// Increase Express JSON and URL-encoded limits to 50mb
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Global request logger to track every single incoming request and headers
app.use((req, res, next) => {
    console.log(`[Incoming Request] Method: ${req.method} | URL: ${req.url} | Origin: ${req.headers.origin || 'none'}`);
    next();
});

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

// Configure Multer with a file size limit (50MB per file) and whitelist filtering
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { 
        fileSize: 50 * 1024 * 1024 // 50MB limit per file
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 
            'image/png', 
            'image/webp', 
            'video/mp4', 
            'video/quicktime'
        ];

        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true); 
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, WEBP images and MP4/MOV videos are allowed.'), false); 
        }
    }
});

// ==========================================
// HELPER FUNCTIONS FOR TYPE SAFETY & SANITIZATION
// ==========================================
const parseInteger = (val) => {
    if (val === '' || val === undefined || val === null || isNaN(val)) return null;
    return parseInt(val, 10);
};

const parseNumeric = (val) => {
    if (val === '' || val === undefined || val === null || isNaN(val)) return null;
    return parseFloat(val);
};

const sanitizeText = (val) => {
    if (!val || typeof val !== 'string') return '';
    return sanitizeHtml(val, {
        allowedTags: [], // Strips all HTML/script tags entirely to protect against XSS
        allowedAttributes: {}
    });
};

// ==========================================
// CLIENT INITIALIZATIONS & BUCKET CONFIGS
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

const S3_BUCKET_INCOMING = process.env.AWS_S3_BUCKET_INCOMING;
const S3_BUCKET_ACTIVE = process.env.AWS_S3_BUCKET_ACTIVE;
const S3_BUCKET_DELETED = process.env.AWS_S3_BUCKET_DELETED;

// ==========================================
// S3 UTILITY: MIGRATE ASSETS BETWEEN BUCKETS
// ==========================================
async function migrateListingImages(imageUrls, sourceBucket, targetBucket) {
    if (!imageUrls || imageUrls.length === 0) return;

    for (const url of imageUrls) {
        try {
            const urlObj = new URL(url);
            const key = decodeURIComponent(urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname);

            // 1. Copy object to target bucket
            await s3Client.send(new CopyObjectCommand({
                Bucket: targetBucket,
                CopySource: `${sourceBucket}/${key}`,
                Key: key
            }));

            // 2. Delete object from source bucket
            await s3Client.send(new DeleteObjectCommand({
                Bucket: sourceBucket,
                Key: key
            }));
        } catch (err) {
            console.error(`Failed to migrate image ${url} from ${sourceBucket} to ${targetBucket}:`, err);
        }
    }
}

// ==========================================
// 1. IMAGE UPLOAD ROUTE (AWS S3 - Incoming Bucket)
// ==========================================
app.post('/upload', upload.array('images', 5), async (req, res) => {
    const listingId = req.headers['listing-id'];
    const listingTag = req.headers['listing-tag'];

    if (!listingId) {
        return res.status(400).json({ success: false, error: 'Missing listing-id header.' });
    }

    try {
        if (!req.files || req.files.length === 0) {
            console.log(`[Upload] Listing ${listingId} submitted with 0 images. Continuing without upload.`);
            return res.status(200).json({ success: true, urls: [] });
        }

        const uploadedImageUrls = [];

        for (const [index, file] of req.files.entries()) {
            const fileExtension = file.originalname ? file.originalname.split('.').pop() : 'jpg';
            const fileName = `listings/${listingId}/image_${index + 1}_${Date.now()}.${fileExtension}`;
            
            const uploadParams = {
                Bucket: S3_BUCKET_INCOMING,
                Key: fileName,
                Body: file.buffer,
                ContentType: file.mimetype || 'image/jpeg'
            };

            await s3Client.send(new PutObjectCommand(uploadParams));

            const fileUrl = `https://${S3_BUCKET_INCOMING}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
            uploadedImageUrls.push(fileUrl);
        }

        return res.status(200).json({ success: true, urls: uploadedImageUrls });
    } catch (err) {
        console.error('AWS S3 Upload Error:', err);
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
                title: sanitizeText(payload.title) || 'Untitled Vehicle',
                description: sanitizeText(payload.vehicle.description) || '',
                image_urls: payload.images || [],
                
                asking_price: parseNumeric(payload.vehicle.askingPrice),
                negotiate: sanitizeText(payload.vehicle.negotiate) || '',
                plus_minus: parseNumeric(payload.vehicle.plusMinus),
                fulfillment: sanitizeText(payload.vehicle.fulfillment) || '',

                starting_price: parseNumeric(payload.vehicle.startingPrice),
                buy_outright: parseNumeric(payload.vehicle.buyOutright),
                activity: sanitizeText(payload.vehicle.activity) || '',
                auction_length: sanitizeText(payload.vehicle.auctionLength) || '',
                time_unit: sanitizeText(payload.vehicle.timeUnit) || '',
                
                vehicle_type: sanitizeText(payload.vehicle.category) || '',
                make: sanitizeText(payload.vehicle.make) || '',
                model: sanitizeText(payload.vehicle.model) || '',
                trim: sanitizeText(payload.vehicle.trim) || '',
                year: parseInteger(payload.vehicle.year),
                theme: sanitizeText(payload.vehicle.theme) || '',
                vin: sanitizeText(payload.vehicle.vin) || '',
                condition: sanitizeText(payload.vehicle.condition) || '',
                mileage: parseInteger(payload.vehicle.mileage),
                fuel: sanitizeText(payload.vehicle.fuel) || '',
                drive_type: sanitizeText(payload.vehicle.driveType) || '',
                transmission: sanitizeText(payload.vehicle.transmission) || '',
                fuel_efficiency: sanitizeText(payload.vehicle.fuelEfficiency) || '',
                exterior_color: sanitizeText(payload.vehicle.exteriorColor) || '',
                interior_color: sanitizeText(payload.vehicle.interiorColor) || '',
                performance_upgrades: sanitizeText(payload.vehicle.performanceUpgrades) || '',
                aesthetic_upgrades: sanitizeText(payload.vehicle.aestheticUpgrades) || '',
                engine_type: sanitizeText(payload.vehicle.engineType) || '',
                horsepower: sanitizeText(payload.vehicle.horsepower) || '',
                suspension: sanitizeText(payload.vehicle.suspension) || '',
                tires: sanitizeText(payload.vehicle.tires) || '',
                
                contact_name: sanitizeText(payload.contact?.name) || '',
                contact_address: sanitizeText(payload.contact?.address) || '',
                contact_city: sanitizeText(payload.contact?.city) || '',
                contact_state: sanitizeText(payload.contact?.state) || '',
                contact_zip_code: sanitizeText(payload.contact?.zipCode) || '',
                contact_phone: sanitizeText(payload.contact?.phone) || '',
                contact_email: sanitizeText(payload.contact?.email) || '',
                
                auth_username: sanitizeText(payload.auth?.username) || '',
                auth_password: payload.auth?.password || '', 
                legal_listing_choice: sanitizeText(payload.auth?.legalListingChoice) || ''
            };
        } else if (payload.part) {
            dbRecord = {
                unique_listing_id: payload.id?.uniquePartListingID,
                category: 'part',
                status: 'incoming',
                title: sanitizeText(payload.title) || 'Untitled Part',
                description: sanitizeText(payload.description) || '',
                image_urls: payload.images || [],
                
                asking_price: parseNumeric(payload.price?.askingPrice),
                negotiate: sanitizeText(payload.price?.negotiate) || '',
                plus_minus: parseNumeric(payload.price?.plusMinus),
                fulfillment: sanitizeText(payload.price?.fulfillment) || '',
                
                part_name: sanitizeText(payload.part.partName) || '',
                part_category: sanitizeText(payload.part.category) || '',
                part_type: sanitizeText(payload.part.partType) || '',
                part_brand: sanitizeText(payload.part.partBrand) || '',
                part_model: sanitizeText(payload.part.partModel) || '',
                part_year: sanitizeText(payload.part.partYear) || '',
                
                compat_vehicle_type: sanitizeText(payload.compatibility?.vehicleType) || '',
                compat_make: sanitizeText(payload.compatibility?.make) || '',
                compat_model: sanitizeText(payload.compatibility?.model) || '',
                compat_trim: sanitizeText(payload.compatibility?.trim) || '',
                compat_from_year: sanitizeText(payload.compatibility?.fromYear) || '',
                compat_to_year: sanitizeText(payload.compatibility?.toYear) || '',
                
                part_availability: sanitizeText(payload.partInfo?.availability) || '',
                part_size: sanitizeText(payload.partInfo?.size) || '',
                part_compatibility: sanitizeText(payload.partInfo?.partCompatibility) || '',
                part_number: sanitizeText(payload.partInfo?.partNumber) || '',
                warranty: sanitizeText(payload.partInfo?.warranty) || '',
                material: sanitizeText(payload.partInfo?.material) || '',
                dimensions: sanitizeText(payload.partInfo?.dimensions) || '',
                weight: sanitizeText(payload.partInfo?.weight) || '',
                color: sanitizeText(payload.partInfo?.color) || '',
                finish: sanitizeText(payload.partInfo?.finish) || '',
                power_source: sanitizeText(payload.partInfo?.powerSource) || '',
                
                contact_name: sanitizeText(payload.contact?.name) || '',
                contact_address: sanitizeText(payload.contact?.address) || '',
                contact_city: sanitizeText(payload.contact?.city) || '',
                contact_state: sanitizeText(payload.contact?.state) || '',
                contact_zip_code: sanitizeText(payload.contact?.zipCode) || '',
                contact_phone: sanitizeText(payload.contact?.phone) || '',
                contact_email: sanitizeText(payload.contact?.email) || '',
                
                auth_username: sanitizeText(payload.auth?.username) || '',
                auth_password: payload.auth?.password || '',
                legal_listing_choice: sanitizeText(payload.auth?.legalListingChoice) || ''
            };
        } else if (payload.service) {
            dbRecord = {
                unique_listing_id: payload.id?.uniqueServiceListingID,
                category: 'service',
                status: 'incoming',
                title: sanitizeText(payload.title) || 'Untitled Service',
                description: sanitizeText(payload.description) || '',
                image_urls: payload.images || [],
                service_url: sanitizeText(payload.url) || '',
                
                service_category: sanitizeText(payload.service?.category) || '',
                service_type: sanitizeText(payload.service?.type) || '',
                custom_service_type: sanitizeText(payload.service?.customType) || '',
                company_name: sanitizeText(payload.service?.companyName) || '',
                service_address: sanitizeText(payload.service?.serviceAddress) || '',
                service_city: sanitizeText(payload.service?.city) || '',
                service_state: sanitizeText(payload.service?.state) || '',
                service_zip: sanitizeText(payload.service?.zipCode) || '',
                
                hours_monday: sanitizeText(payload.openHours?.monday) || '',
                hours_tuesday: sanitizeText(payload.openHours?.tuesday) || '',
                hours_wednesday: sanitizeText(payload.openHours?.wednesday) || '',
                hours_thursday: sanitizeText(payload.openHours?.thursday) || '',
                hours_friday: sanitizeText(payload.openHours?.friday) || '',
                hours_saturday: sanitizeText(payload.openHours?.saturday) || '',
                hours_sunday: sanitizeText(payload.openHours?.sunday) || '',
                
                service_row_title: sanitizeText(payload.service_row?.service_title) || '',
                service_row_description: sanitizeText(payload.service_row?.service_description) || '',
                service_row_parts_included: sanitizeText(payload.service_row?.service_parts_included) || '',
                service_row_labor_included: sanitizeText(payload.service_row?.service_labor_included) || '',
                service_row_price: sanitizeText(payload.service_row?.service_price) || '',
                service_row_duration: sanitizeText(payload.service_row?.service_duration) || '',
                
                contact_name: sanitizeText(payload.contact?.name) || '',
                contact_phone: sanitizeText(payload.contact?.phone) || '',
                contact_email: sanitizeText(payload.contact?.email) || '',
                
                auth_username: sanitizeText(payload.auth?.username) || '',
                auth_password: payload.auth?.password || '',
                legal_listing_choice: sanitizeText(payload.auth?.legalListingChoice) || ''
            };
        } else {
            return res.status(400).json({ success: false, error: 'Unknown payload structure category.' });
        }

        if (!dbRecord.unique_listing_id) {
            return res.status(400).json({ success: false, error: 'Missing unique listing ID in payload.' });
        }

        if (dbRecord.auth_password && dbRecord.auth_password.trim() !== '') {
            const saltRounds = 10;
            dbRecord.auth_password = await bcrypt.hash(dbRecord.auth_password, saltRounds);
        } else {
            dbRecord.auth_password = null;
        }

        const { error } = await supabase
            .from('listings')
            .upsert(dbRecord, { onConflict: 'unique_listing_id' });

        if (error) throw error;

        return res.status(200).json({ success: true, message: 'Listing successfully received and stored as incoming.' });
    } catch (err) {
        console.error('Database Upsert Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/listings/active', async (req, res) => {
    try {
        // 1. Fetch active listings from Supabase
        const { data: listings, error } = await supabase
            .from('listings')
            .select('*')
            .eq('status', 'active');

        if (error) throw error;

        // 2. Loop through listings and sign their images
        const listingsWithSignedUrls = await Promise.all(listings.map(async (listing) => {
            if (listing.image_urls && listing.image_urls.length > 0) {
                const signedUrls = await Promise.all(listing.image_urls.map(async (url) => {
                    try {
                        const urlObj = new URL(url);
                        const bucketName = urlObj.hostname.split('.')[0];
                        const key = decodeURIComponent(urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname);

                        const command = new GetObjectCommand({
                            Bucket: bucketName,
                            Key: key
                        });

                        // Generate a URL that expires in 1 hour (3600 seconds)
                        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                    } catch (err) {
                        console.error('Error signing URL:', err);
                        return url; // Fallback to original if it fails
                    }
                }));
                listing.image_urls = signedUrls; // Replace raw S3 URLs with signed ones
            }
            return listing;
        }));

        // 3. Send the updated listings to the frontend
        return res.status(200).json({ success: true, listings: listingsWithSignedUrls });

    } catch (err) {
        console.error('Error fetching active listings:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// PUBLIC ENDPOINT: FETCH ACTIVE LISTINGS BY CATEGORY
// ==========================================
app.get('/api/listings/category/:category', async (req, res) => {
    const categoryName = req.params.category.toLowerCase();

    try {
        // 1. Fetch active listings filtered by category from Supabase
        const { data: listings, error } = await supabase
            .from('listings')
            .select('*')
            .eq('status', 'active')
            .eq('category', categoryName);

        if (error) throw error;

        // 2. Loop through listings and sign their S3 image/video URLs using the active bucket
        const listingsWithSignedUrls = await Promise.all(listings.map(async (listing) => {
            if (listing.image_urls && listing.image_urls.length > 0) {
                const signedUrls = await Promise.all(listing.image_urls.map(async (url) => {
                    try {
                        const urlObj = new URL(url);
                        const key = decodeURIComponent(urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname);

                        const command = new GetObjectCommand({
                            Bucket: S3_BUCKET_ACTIVE,
                            Key: key
                        });

                        // Generate a secure URL that expires in 1 hour (3600 seconds)
                        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                    } catch (err) {
                        console.error('Error signing URL for category listing:', err);
                        return url; // Fallback to raw URL if parsing fails
                    }
                }));
                listing.image_urls = signedUrls; // Replace raw URLs with secure signed ones
            }
            return listing;
        }));

        // 3. Send response back to the frontend
        return res.status(200).json({ success: true, listings: listingsWithSignedUrls });

    } catch (err) {
        console.error(`Error fetching active listings for category "${categoryName}":`, err);
        return res.status(500).json({ success: false, error: err.message });
    }
});


// ==========================================
// PUBLIC ENDPOINT: FETCH FEATURED LISTINGS
// ==========================================
app.get('/featured', async (req, res) => {
    try {
        // 1. Fetch active listings from Supabase
        const { data: listings, error } = await supabase
            .from('listings')
            .select('*')
            .eq('status', 'active');

        if (error) throw error;

        // 2. Separate listings into categories (vehicles, parts, services)
        const vehicles = [];
        const parts = [];
        const services = [];

        listings.forEach(listing => {
            if (listing.category === 'vehicle') vehicles.push(listing);
            else if (listing.category === 'part') parts.push(listing);
            else if (listing.category === 'service') services.push(listing);
        });

        // Optional: Limit or slice to display a specific number of featured items (e.g., top 4 each)
        const featuredVehicles = vehicles.slice(0, 4);
        const featuredParts = parts.slice(0, 4);
        const featuredServices = services.slice(0, 4);

        const allFeatured = [...featuredVehicles, ...featuredParts, ...featuredServices];

        // 3. Sign the S3 image URLs for the featured subset using the active bucket
        const processedListings = await Promise.all(allFeatured.map(async (listing) => {
            if (listing.image_urls && listing.image_urls.length > 0) {
                // Grab the first image as the primary featured thumbnail
                const primaryImage = listing.image_urls[0];
                try {
                    const urlObj = new URL(primaryImage);
                    const key = decodeURIComponent(urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname);

                    const command = new GetObjectCommand({
                        Bucket: S3_BUCKET_ACTIVE,
                        Key: key
                    });

                    // Generate a secure signed URL that expires in 1 hour
                    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                    listing.image = signedUrl; // Assign to single .image property expected by your frontend
                } catch (err) {
                    console.error('Error signing featured listing image URL:', err);
                    listing.image = primaryImage; // Fallback
                }
            } else {
                listing.image = '';
            }

            // Map unique database ID back to the structure your frontend script checks
            listing.id = { uniqueListingID: listing.unique_listing_id };
            return listing;
        }));

        // Group them back neatly to match your frontend extraction logic
        const responseData = {
            vehicles: processedListings.filter(l => l.category === 'vehicle'),
            parts: processedListings.filter(l => l.category === 'part'),
            services: processedListings.filter(l => l.category === 'service')
        };

        return res.status(200).json({ success: true, ...responseData });

    } catch (err) {
        console.error('Error fetching featured listings:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// ADMIN MIDDLEWARE & ROUTES
// ==========================================
const verifyAdmin = (req, res, next) => {
    const adminKey = req.headers['x-admin-secret'];

    console.log(`[DEBUG] Incoming Header: "${adminKey}" | Render Env: "${process.env.ADMIN_SECRET_KEY}"`);
    
    if (!adminKey || adminKey !== process.env.ADMIN_SECRET_KEY) {
        console.warn(`[Admin Security] Blocked unauthorized attempt with key: "${adminKey}"`);
        return res.status(403).json({ success: false, error: 'Access Denied: Invalid Admin Secret' });
    }
    next();
};

app.get('/api/admin/image-proxy', verifyAdmin, async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('Missing image URL');

    try {
        const urlObj = new URL(imageUrl);
        const bucketName = urlObj.hostname.split('.')[0];
        const key = decodeURIComponent(urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname);

        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: key
        });

        const s3Response = await s3Client.send(command);

        res.setHeader('Content-Type', s3Response.ContentType || 'image/jpeg');
        // Pipe the S3 readable stream directly to the Express response
        s3Response.Body.pipe(res);
    } catch (err) {
        console.error('Image Proxy Error:', err);
        res.status(404).send('Image not found or inaccessible');
    }
});

// 1. Fetch all incoming listings pending review
app.get('/api/admin/incoming', verifyAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('listings')
            .select('*')
            .eq('status', 'incoming')
            .order('created_at', { ascending: false });

        if (error) throw error;
        return res.status(200).json({ success: true, listings: data });
    } catch (err) {
        console.error('Error fetching incoming listings:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Approve listing: Moves S3 assets from Incoming -> Active & sets status to 'active'
app.put('/api/admin/listings/:id/approve', verifyAdmin, async (req, res) => {
    const listingId = req.params.id;

    try {
        const { data: listing, error: fetchError } = await supabase
            .from('listings')
            .select('image_urls')
            .eq('unique_listing_id', listingId)
            .single();

        if (fetchError || !listing) {
            return res.status(404).json({ success: false, error: 'Listing not found.' });
        }

        await migrateListingImages(listing.image_urls, S3_BUCKET_INCOMING, S3_BUCKET_ACTIVE);

        const { error: updateError } = await supabase
            .from('listings')
            .update({ status: 'active' })
            .eq('unique_listing_id', listingId);

        if (updateError) throw updateError;

        return res.status(200).json({ success: true, message: 'Listing approved and assets moved to active bucket.' });
    } catch (err) {
        console.error('Error approving listing:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Reject/Delete listing: Moves S3 assets from Incoming -> Deleted & sets status to 'deleted'
app.delete('/api/admin/listings/:id', verifyAdmin, async (req, res) => {
    const listingId = req.params.id;

    try {
        const { data: listing, error: fetchError } = await supabase
            .from('listings')
            .select('image_urls')
            .eq('unique_listing_id', listingId)
            .single();

        if (fetchError || !listing) {
            return res.status(404).json({ success: false, error: 'Listing not found.' });
        }

        await migrateListingImages(listing.image_urls, S3_BUCKET_INCOMING, S3_BUCKET_DELETED);

        const { error: updateError } = await supabase
            .from('listings')
            .update({ status: 'deleted' })
            .eq('unique_listing_id', listingId);

        if (updateError) throw updateError;

        return res.status(200).json({ success: true, message: 'Listing rejected and assets moved to deleted bucket.' });
    } catch (err) {
        console.error('Error deleting listing:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(port, () => {
    console.log(`Server running smoothly on port ${port}`);
});
