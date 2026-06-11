const express = require('express');
const cors = require('cors');
const compression = require('compression'); 
require('dotenv').config(); 

// 📦 DYNAMIC ENGINE: Automatically reads your exact project name from your package.json file!
const pjson = require('./package.json');
const PROJECT_NAME = pjson.name || 'default-app'; 

// 🛸 Pull in your independent route file
const gasPricesRoute = require('./routes/gasPrices');


const app = express();

app.use(compression()); 
app.use(express.json()); 

// 🛡️ SECURITY SCHEMA (UNIVERSAL SKELETON)
const allowedOrigins = [
    'https://gas-watch.com', // 💡 Just swap this single line for your new live brand domain name in future apps
    'http://localhost:5500',        
    'http://localhost:3000'         
]; 

app.use(cors({
    origin: function (origin, callback) {
        // Safe pass if running locally or matching your exact production custom brand domain
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        }

        // 🛸 DYNAMIC VERCEL SHIELD: Completely automated!
        // Checks that the domain ends in .vercel.app AND automatically injects your true project name variable!
        const isVercelSubdomain = origin.endsWith('.vercel.app') && origin.includes(PROJECT_NAME);

        if (isVercelSubdomain) {
            callback(null, true);
        } else {
            callback(new Error('Blocked by CORS policy: Unauthorized domain request.'));
        }
    }
}));

// 🔌 Mount it instantly onto your server routing path
app.use('/api/gas-prices', gasPricesRoute);

// ⚡ VERCEL ADAPTATION: Local environments use port 3000, while Vercel's serverless pipeline 
// natively manages the module export architecture automatically in production.
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Secure gateway running locally on port ${PORT}`));
}

module.exports = app; // Required by Vercel serverless functions