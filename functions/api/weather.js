/**
 * Weather Forecast API
 * 
 * Proxy for Open-Meteo API to handle CORS.
 * GET /api/weather?lat=40.71&lon=-74.01&timezone=auto
 */

var OPEN_METEO_BASE = 'https://api.open-meteo.com/v1';

export async function onRequest(context) {
  var url = new URL(context.request.url);
  var lat = url.searchParams.get('lat') || '40.71';
  var lon = url.searchParams.get('lon') || '-74.01';
  var tz = url.searchParams.get('timezone') || 'auto';
  
  var apiUrl = OPEN_METEO_BASE + '/forecast?latitude=' + lat + '&longitude=' + lon + 
    '&current_weather=true&hourly=temperature_2m,relativehumidity_2m,precipitation_probability' +
    '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset,windspeed_10m_max' +
    '&timezone=' + encodeURIComponent(tz) + '&forecast_days=7';
  
  try {
    var response = await fetch(apiUrl);
    if (!response.ok) {
      return new Response(JSON.stringify({ error: 'API error: ' + response.status }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    var data = await response.json();
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
