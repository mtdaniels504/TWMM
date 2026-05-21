export default async function handler(req, res) {
    // Stop people from hitting this link via a standard browser window
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Securely read the key from the hidden .env file on the server side
    const APIFY_TOKEN = process.env.APIFY_TOKEN;
    const ACTOR_ID = "johnvc~fuelprices";

    try {
        const rawApifyUrl = `https://apify.com{ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=120`;

        // The backend talks to Apify out of public sight
        const apifyResponse = await fetch(rawApifyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body) 
        });

        if (!apifyResponse.ok) throw new Error("Apify rejected request");

        const data = await apifyResponse.json();

        // Send the clean gas data back to your map script
        return res.status(200).json(data);

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}