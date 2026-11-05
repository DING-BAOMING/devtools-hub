import { isAdmin } from '../../libs/admin-auth.js';

export async function onRequestGet(context) {
    const FEEDBACK_KEY = 'feedback_list';
    const { searchParams } = new URL(context.request.url);
    // BUG-401: the public list published every submitter's email address to anyone who
    // loaded /tools/feedback/ — 100/100 queued entries carried one. The published privacy
    // policy promises the opposite: "used only to reply to you ... never sold, shared, or
    // used for marketing" (/privacy/). The address stays in KV so the owner can still
    // reply; it is only withheld from the unauthenticated response. An admin request
    // (admin_secret) still gets it — that is how a reply is written.
    const admin = isAdmin(context, searchParams);

    try {
        const feedbackList = await context.env.FEEDBACK_KV.get(FEEDBACK_KEY, 'json');
        const feedback = (feedbackList || []).map(f => {
            if (admin || !('email' in f)) return f;
            const { email, ...rest } = f;
            return rest;
        });
        
        feedback.sort((a, b) => {
            if (a.resolved !== b.resolved) {
                return a.resolved ? 1 : -1;
            }
            return new Date(b.timestamp) - new Date(a.timestamp);
        });
        
        return new Response(JSON.stringify(feedback), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            }
        });
    } catch (e) {
        return new Response(JSON.stringify([]), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export async function onRequestPost(context) {
    const FEEDBACK_KEY = 'feedback_list';
    
    try {
        const body = await context.request.json();
        const { category, type, description, email, tool } = body;
        
        if (!category || !type || !description) {
            return new Response(JSON.stringify({ error: 'Missing required fields' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        const feedbackList = await context.env.FEEDBACK_KV.get(FEEDBACK_KEY, 'json') || [];
        
        const newFeedback = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
            category,
            tool: tool || 'Other',
            type,
            description: description.substring(0, 2000),
            email: email || '',
            resolved: false,
            timestamp: new Date().toISOString()
        };
        
        feedbackList.unshift(newFeedback);
        
        if (feedbackList.length > 100) {
            feedbackList.length = 100;
        }
        
        await context.env.FEEDBACK_KV.put(FEEDBACK_KEY, JSON.stringify(feedbackList));
        
        return new Response(JSON.stringify({ success: true, id: newFeedback.id }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export async function onRequestPatch(context) {
    const FEEDBACK_KEY = 'feedback_list';
    const { searchParams } = new URL(context.request.url);
    if (!isAdmin(context, searchParams)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    try {
        const body = await context.request.json();
        const { id, resolved, adminNote, delete: shouldDelete } = body;
        
        if (!id) {
            return new Response(JSON.stringify({ error: 'Missing feedback ID' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        const feedbackList = await context.env.FEEDBACK_KV.get(FEEDBACK_KEY, 'json') || [];
        
        if (shouldDelete) {
            const filtered = feedbackList.filter(f => f.id !== id);
            await context.env.FEEDBACK_KV.put(FEEDBACK_KEY, JSON.stringify(filtered));
            return new Response(JSON.stringify({ success: true, deleted: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        const feedback = feedbackList.find(f => f.id === id);
        
        if (!feedback) {
            return new Response(JSON.stringify({ error: 'Feedback not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        if (resolved !== undefined) {
            feedback.resolved = resolved;
        }
        if (adminNote !== undefined) {
            feedback.adminNote = adminNote.substring(0, 500);
        }
        feedback.updatedAt = new Date().toISOString();
        
        await context.env.FEEDBACK_KV.put(FEEDBACK_KEY, JSON.stringify(feedbackList));
        
        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export async function onRequestDelete(context) {
    const FEEDBACK_KEY = 'feedback_list';
    const { searchParams } = new URL(context.request.url);
    if (!isAdmin(context, searchParams)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    try {
        const { id } = await context.request.json();
        
        if (!id) {
            return new Response(JSON.stringify({ error: 'Missing feedback ID' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        const feedbackList = await context.env.FEEDBACK_KV.get(FEEDBACK_KEY, 'json') || [];
        const filtered = feedbackList.filter(f => f.id !== id);
        
        await context.env.FEEDBACK_KV.put(FEEDBACK_KEY, JSON.stringify(filtered));
        
        return new Response(JSON.stringify({ success: true, deleted: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
