import { createServer } from 'node:http'

import { createPdfExportHandler } from '../src/lib/pdf-export.js'

const port = Number.parseInt(process.env.PORT ?? '7071', 10)
const allowedOrigin = process.env.ALLOWED_ORIGIN
const requestsPerMinute = Number.parseInt(
  process.env.EXPORT_REQUESTS_PER_MINUTE ?? '3',
  10,
)
const exportHandler = createPdfExportHandler({
  requestsPerMinute: Number.isFinite(requestsPerMinute) && requestsPerMinute > 0
    ? requestsPerMinute
    : 3,
})

function setCorsHeaders(request, response) {
  if (allowedOrigin && request.headers.origin === allowedOrigin) {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    response.setHeader('Vary', 'Origin')
  }
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  setCorsHeaders(request, response)

  if (pathname === '/health') {
    response.statusCode = 200
    response.end('ok')
    return
  }
  if (pathname !== '/api/export') {
    response.statusCode = 404
    response.end('Not Found')
    return
  }
  if (request.method === 'OPTIONS') {
    response.statusCode = 204
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.end()
    return
  }
  await exportHandler(request, response)
})

server.requestTimeout = 65_000
server.headersTimeout = 66_000
server.listen(port, '0.0.0.0', () => {
  console.log(`PDF export service listening on ${port}`)
})
