const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Loads secret keys from a hidden file

const app = express();
app.use(express.json());

// SECURITY: Only allow requests originating from your actual website domain
const allowedOrigins = ['https://gas-watch.com', 'http://github.io', 'http://localhost:5500']; 
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Blocked by CORS policy: Unauthorized domain request.'));
        }
    }
}));

// The secure endpoint your frontend will talk to
app.post('/api/gas-prices', async (req, res) => {
    try {
        const { search } = req.body;
        
        // 1. Fetch your secret token safely from the server's private environment variables
        const APIFY_TOKEN = process.env.APIFY_TOKEN; 
        const ACTOR_ID = "johnvc~fuelprices";
        
        if (!APIFY_TOKEN) {
            return res.status(500).json({ error: "Server configuration missing API key." });
        }

        // 2. Strict backend-controlled input configuration
        const inputConfig = {
            "search": search || "Denver",
            "fuel": 1,
            "maxAge": 0,
            "lang": "en",
            "radius": 15
        };

        const apifyUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=120`;

        // 3. Make the API call from the server, entirely hidden from the browser
        const apifyResponse = await fetch(apifyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(inputConfig)
        });

        if (!apifyResponse.ok) {
            throw new Error(`Apify returned status code: ${apifyResponse.status}`);
        }

        const data = await apifyResponse.json();
        
        // 4. Send the raw dataset items back to your frontend map
        res.json(data);

    } catch (error) {
        console.error("Backend processing error:", error.message);
        res.status(500).json({ error: "Failed to fetch fuel prices securely." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Secure gateway running on port ${PORT}`));