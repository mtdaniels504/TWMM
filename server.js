require('dotenv').config();

const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { smartIngestion, runIngestion } = require('./ingest.js');

const app = express();

// Middleware
app.use(express.json());
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

// Supabase Client Setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function applyLocationFilter(queryBuilder, queryType, components) {
  const city = components?.city?.toLowerCase() || '';
  const state = components?.state?.toUpperCase() || '';
  const zip = components?.zip || '';
  const storeOrAddress = components?.storeOrAddress?.toLowerCase() || '';

  switch (queryType) {
    case 'city_state':
      return queryBuilder.ilike('city', `%${city}%`).eq('state', state);
    case 'city':
      return queryBuilder.ilike('city', `%${city}%`);
    case 'zip':
      return queryBuilder.eq('zip', zip);
    case 'state':
      return queryBuilder.eq('state', state); // Use exact column match instead of address substring search
    case 'text_fallback':
    default:
      const fallback = storeOrAddress || city || zip;
      return queryBuilder.or(`city.ilike.%${fallback}%,address.ilike.%${fallback}%,name.ilike.%${fallback}%`);
  }
}

// --- ROUTES ---

app.post('/api/gas-prices', async (req, res) => {
  try {
    const { search, queryType, components, forceRefresh } = req.body;
    
    if (!search) {
      return res.status(400).json({ error: 'Missing search query' });
    }

    // Determine the ideal target string for Apify/Ingestion lookup
    const ingestionTarget = (components?.city && components?.state) 
      ? `${components.city}, ${components.state}` 
      : search;

    const status = await smartIngestion(ingestionTarget, queryType, components);

    // 1. MISSING: Run ingestion and return immediately
    if (status === 'MISSING' || forceRefresh) {
      const result = await runIngestion(ingestionTarget);
      
      if (result.status === 'EMPTY') {
        return res.json({
          status: 'OK',
          info: 'No Stations Found. Please check your search.',
        });
      }
      
      return res.json({
        status: 'OK',
        info: 'Gas Prices Successfully Updated, Geocoding New Locations...',
        stations: result.stations,
      });
    }

    // 2. STALE: Inform the user
    if (status === 'STALE' && !forceRefresh) {
      let query = supabase.from('gas_stations').select('*');
      query = applyLocationFilter(query, queryType, components);
      const { data } = await query;

      return res.json({
        status: 'STALE',
        message: 'Prices are over 48h old. Would you like to fetch new prices from the network?',
        stations: data || [],
      });
    }

    // 3. FRESH: Fetch and include all, even if some are still geocoding
    let query = supabase.from('gas_stations').select('*');
    query = applyLocationFilter(query, queryType, components);
    const { data } = await query;

    const stationList = data || [];
    const hasNulls = stationList.some((s) => s.lat === null || s.lon === null);

    return res.json({
      status: 'OK',
      stations: stationList,
      info: hasNulls ? 'Geocoding New Locations...' : null,
    });

  } catch (err) {
    console.error('🚨 Backend Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/check-progress', async (req, res) => {
    try {
        const { query } = req.query;
        
        if (!query) {
            return res.status(400).json({ error: 'Query required' });
        }

        // 🔍 DEBUG: Log the incoming search parameter
        console.log(`🔎 [Progress Check] Checking progress for query: "${query}"`);

        const filterString = `lat.is.null,lon.is.null`;
        const locationString = `city.ilike.%${query}%,address.ilike.%${query}%`;
        
        console.log(`🔎 [Progress Check] Location Filter: ${locationString}`);
        console.log(`🔎 [Progress Check] Coordinate Filter: ${filterString}`);

        const { count, error } = await supabase
            .from('gas_stations')
            .select('*', { count: 'exact', head: true })
            .or(locationString)
            .or(filterString);

        if (error) {
            console.error("🚨 Supabase Error Details (Full JSON):", JSON.stringify(error, null, 2));
            throw error;
        }

        // 🔍 DEBUG: Log the result of the query
        console.log(`✅ [Progress Check] Result count for missing coords: ${count}`);

        return res.json({ hasNulls: count > 0 });

    } catch (err) {
        console.error('🚨 Progress Check Error:', err.message || err);
        return res.status(500).json({ error: 'Failed to check progress' });
    }
});

// --- SERVER STARTUP ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
