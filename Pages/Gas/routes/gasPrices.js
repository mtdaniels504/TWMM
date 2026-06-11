const express = require('express');
const router = express.Router();
const NodeCache = require('node-cache'); // ⚡ PRO MOVE: Saves your free-tier budget and speeds up searches to 5ms!

// Initialize your cache with a default "Time to Live" of 15 minutes (900 seconds)
const gasCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });


router.post('/', async (req, res) => {
    try {
        // Extract parameters, including our newly added forward-facing radius slider!
        const { search, lat, lon, radius } = req.body;
        
        const APIFY_TOKEN = process.env.APIFY_TOKEN; 
        const ACTOR_ID = "johnvc~fuelprices";
        
        if (!APIFY_TOKEN) {
            console.error("Critical Fault: APIFY_TOKEN missing from environment vault.");
            return res.status(500).json({ error: "Server configuration missing API key." });
        }

        // 🗺️ GPS TARGETING LOGIC: Format precise coordinates if they exist
        let finalSearchParameter = search || "Denver";
        let cacheKey = finalSearchParameter.toLowerCase(); // Create a clean lookup key for our memory bank
        
        if (lat && lon && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lon))) {
            finalSearchParameter = `${parseFloat(lat)},${parseFloat(lon)}`;
            cacheKey = `gps-${parseFloat(lat).toFixed(4)},${parseFloat(lon).toFixed(4)}`;
            console.log(`Targeting precise GPS coordinates: ${finalSearchParameter}`);
        } else {
            console.log(`Targeting textual location string: ${finalSearchParameter}`);
        }

        // ⚡ PRO CACHE LOOKUP: Check if this identical search area was requested in the last 15 mins
        const cachedData = gasCache.get(cacheKey);
        if (cachedData) {
            console.log(`🚀 CACHE HIT: Serving gas data for [${cacheKey}] from memory in 5ms!`);
            return res.json(cachedData); // Instant execution return - skips Apify entirely!
        }

        console.log(`📡 CACHE MISS: Contacting Apify for fresh dataset results...`);

        // Convert the incoming radius or fallback cleanly to an integer match
        const searchRadius = parseInt(radius) && !isNaN(parseInt(radius)) ? parseInt(radius) : 15;

        // 📋 Strict backend-controlled input payload mapped to Apify specification requirements
        const inputConfig = {
            "search": finalSearchParameter, 
            "fuel": 1,                      // 1 = Regular gas
            "maxAge": 0,                    // 0 = Force live data crawl
            "lang": "en",
            "radius": searchRadius          // ⚡ UI Slider Sync: Direct parameter alignment!
        };

        // ✨ FIXED: Corrected the official Apify subdomain, directory layout, and added the missing '$' template symbol
        const apifyUrl = `https://api.apify.com/v2/actors/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=120`;

        const apifyResponse = await fetch(apifyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(inputConfig)
        });

        if (!apifyResponse.ok) {
            throw new Error(`Apify returned system status code: ${apifyResponse.status}`);
        }

        const data = await apifyResponse.json();
        
        // 💾 PRO CACHE WRITE: Saves the fresh data into your server's RAM memory bank!
        // This ensures the next user searching this exact location gets it instantly in 5ms!
        gasCache.set(cacheKey, data);
        console.log(`💾 CACHE WRITE: Saved fresh results for [${cacheKey}] to memory bank.`);

        // Return the raw gas station records directly back to your Leaflet rendering loop
        res.json(data);

    } catch (error) {
        console.error("Backend execution error:", error.message);
        res.status(500).json({ error: "Failed to fetch fuel prices securely." });
    }
});

module.exports = router;