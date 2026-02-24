export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/recipes?id=eq.${id}&limit=1`,
    {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const data = await response.json();

  if (!data || !data.length) {
    return res.status(404).json({ error: 'Recipe not found' });
  }

  res.status(200).json(data[0]);
}
