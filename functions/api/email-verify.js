export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  const url = new URL(request.url);
  const email = url.searchParams.get('email');

  if (!email) {
    return new Response(JSON.stringify({ error: 'Email parameter is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return new Response(JSON.stringify({
      email,
      is_valid: false,
      reason: 'invalid_format',
      message: 'Invalid email format',
      suggestions: []
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const emailvalidationKey = env.DEVTOOLS_EMAILVALIDATION_KEY;
  const zerobounceKey = env.DEVTOOLS_ZEROBOUNCE_KEY;

  let result = null;

  // Try EmailValidation.io first
  if (emailvalidationKey && emailvalidationKey !== 'EMAILVALIDATION_KEY_NOT_SET') {
    try {
      const response = await fetch(
        `https://api.emailvalidation.io/v1/info?email=${encodeURIComponent(email)}&apikey=${emailvalidationKey}`,
        { headers: { 'apikey': emailvalidationKey } }
      );
      
      if (response.ok) {
        const data = await response.json();
        result = {
          email,
          is_valid: data.state === 'deliverable',
          state: data.state,
          reason: data.reason || data.state,
          score: data.score,
          smtp_check: data.smtp_check,
          mx_found: data.mx_found,
          free: data.free,
          disposable: data.disposable,
          role: data.role,
          catch_all: data.catch_all,
          format_valid: data.format_valid,
          did_you_mean: data.did_you_mean,
          source: 'emailvalidation'
        };
      }
    } catch (e) {
      // Continue to fallback
    }
  }

  // Try ZeroBounce as fallback
  if (!result && zerobounceKey && zerobounceKey !== 'ZEROBOUNCE_KEY_NOT_SET') {
    try {
      const response = await fetch(
        `https://api.zerobounce.net/v2/validate?api_key=${zerobounceKey}&email=${encodeURIComponent(email)}`,
        { headers: { 'Content-Type': 'application/json' } }
      );
      
      if (response.ok) {
        const data = await response.json();
        if (data.status !== null) {
          result = {
            email,
            is_valid: ['valid'].includes(data.status.toLowerCase()),
            state: data.status.toLowerCase(),
            reason: data.sub_status || data.status,
            score: null,
            smtp_check: data.mx_found,
            mx_found: data.mx_found,
            free: data.free_email,
            disposable: data.sub_status?.includes('disposable'),
            role: data.sub_status?.includes('role_based'),
            catch_all: data.status.toLowerCase() === 'catch-all',
            format_valid: data.status !== 'invalid',
            did_you_mean: data.did_you_mean,
            smtp_provider: data.smtp_provider,
            source: 'zerobounce'
          };
        }
      }
    } catch (e) {
      // Continue to error
    }
  }

  if (!result) {
    return new Response(JSON.stringify({
      email,
      is_valid: null,
      reason: 'no_api_available',
      message: 'Email verification service not configured. Please try again later.',
      suggestions: []
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Add human-readable message
  result.message = getHumanMessage(result);
  result.suggestions = getSuggestions(result);

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function getHumanMessage(result) {
  if (result.state === 'deliverable' || result.is_valid) {
    return 'This email appears to be valid and can receive messages.';
  }

  const reasons = {
    'invalid_mailbox': 'This mailbox does not exist on the mail server.',
    'invalid_mx': 'The mail server (MX record) for this domain does not exist.',
    'invalid_smtp': 'The mail server is not accepting connections.',
    'disposable': 'This is a temporary/disposable email address.',
    'role_based': 'This is a role-based email (like support@ or info@) which may not reach a specific person.',
    'low_deliverability': 'This email has low deliverability score.',
    'spamtrap': 'This may be a spam trap email address.',
    'catch_all': 'This domain accepts all emails, so we cannot confirm if this specific mailbox exists.',
    'abuse': 'This email is associated with reported abuse.',
    'do_not_mail': 'This email should not be used for outreach.',
    'unknown': 'We could not verify this email address.',
    'invalid_format': 'The email format is invalid.'
  };

  return reasons[result.reason] || `This email could not be verified (${result.reason}).`;
}

function getSuggestions(result) {
  const suggestions = [];

  if (result.did_you_mean) {
    suggestions.push(`Did you mean: ${result.did_you_mean}?`);
  }

  if (!result.mx_found) {
    suggestions.push('Check if the domain name is spelled correctly.');
  }

  if (result.disposable) {
    suggestions.push('Use a permanent personal email address instead.');
  }

  if (result.role) {
    suggestions.push('Consider using a personal email for direct communication.');
  }

  return suggestions;
}
