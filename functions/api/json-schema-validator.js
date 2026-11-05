import { Validator } from '@cfworker/json-schema';

export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }

  if (context.request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers, status: 405 });
  }

  try {
    const body = await context.request.json();
    const { data, schema } = body;

    if (!data || !schema) {
      return new Response(JSON.stringify({ error: 'Both data and schema are required' }), { headers, status: 422 });
    }

    let dataObj, schemaObj;
    try {
      dataObj = typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON data: ' + e.message }), { headers, status: 422 });
    }

    try {
      schemaObj = typeof schema === 'string' ? JSON.parse(schema) : schema;
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON schema: ' + e.message }), { headers, status: 422 });
    }

    const validator = new Validator(schemaObj);
    const result = validator.validate(dataObj);

    if (result.valid) {
      return new Response(JSON.stringify({ valid: true, errors: [] }), { headers });
    }

    const errors = result.errors.map(err => ({
      path: err.instanceLocation || '/',
      keyword: err.keyword || err.error,
      message: err.error,
      params: {}
    }));

    return new Response(JSON.stringify({
      valid: false,
      errors,
      errorCount: errors.length
    }), { headers });

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Validation error: ' + e.message }), { headers, status: 500 });
  }
}
