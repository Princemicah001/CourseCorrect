const handleRequest = require('../server.js');

module.exports = async (req, res) => {
    try {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        urlObj.searchParams.delete('__route');
        const cleanQs = urlObj.searchParams.toString() ? `?${urlObj.searchParams.toString()}` : '';
        req.url = `/api/materials${cleanQs}`;
    } catch {
        req.url = '/api/materials';
    }
    return handleRequest(req, res);
};
