const handleRequest = require('../server.js');

module.exports = async (req, res) => {
    // Vercel Serverless catch-all: reconstruct the intended /api/* path from req.query.slug
    if (req.query && req.query.slug) {
        const slugPath = Array.isArray(req.query.slug) ? req.query.slug.join('/') : req.query.slug;
        const queryIdx = req.url.indexOf('?');
        const qs = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
        req.url = `/api/${slugPath}${qs}`;
    }
    return handleRequest(req, res);
};
