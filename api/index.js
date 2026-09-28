const handleRequest = require('../server.js');

module.exports = async (req, res) => {
    // If request has slug query from Vercel catch-all
    if (req.query && req.query.slug) {
        const slugPath = Array.isArray(req.query.slug) ? req.query.slug.join('/') : req.query.slug;
        const queryIdx = req.url.indexOf('?');
        const qs = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
        req.url = `/api/${slugPath}${qs}`;
    } else {
        const raw = req.headers['x-matched-path'] || req.headers['x-invoke-path'] || req.headers['x-forwarded-uri'] || req.headers['x-real-url'];
        if (raw && raw.startsWith('/api/') && !raw.startsWith('/api/index')) {
            req.url = raw;
        } else if (req.url === '/' || req.url === '/api' || req.url === '/api/') {
            req.url = '/api/materials';
        }
    }
    return handleRequest(req, res);
};
