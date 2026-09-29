const handleRequest = require('../server.js');

module.exports = async (req, res) => {
    try {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        let route = urlObj.searchParams.get('__route') || (req.query && req.query.__route);

        if (!route && req.query && req.query.slug) {
            route = Array.isArray(req.query.slug) ? req.query.slug.join('/') : req.query.slug;
        }
        if (!route && req.query && req.query.path) {
            route = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path;
        }
        if (route) {
            urlObj.searchParams.delete('__route');
            const cleanQs = urlObj.searchParams.toString() ? `?${urlObj.searchParams.toString()}` : '';
            const cleanRoute = route.startsWith('/') ? route.slice(1) : route;
            req.url = `/api/${cleanRoute}${cleanQs}`;
        }
    } catch {}

    return handleRequest(req, res);
};
