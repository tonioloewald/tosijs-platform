import * as path from 'path'
import { statSync, readFileSync } from 'fs'
import { watch } from 'chokidar'
import { gzipSync } from 'zlib'
import { $ } from 'bun'

const PROJECT_ROOT = import.meta.dir

const PUBLIC_DIR = path.resolve(PROJECT_ROOT, 'public')
const BUILD_DIR = path.resolve(PROJECT_ROOT, 'build')
const DIST_DIR = path.resolve(PROJECT_ROOT, 'dist')

const isSPA = true

let isBuilding = false
let buildQueued = false
let lastBuildFailed = false

async function build() {
  if (isBuilding) {
    buildQueued = true
    return
  }

  isBuilding = true
  console.time('build')

  try {
    await $`rm -rf ${DIST_DIR}`.text()
    let result = await Bun.build({
      entrypoints: ['./src/index.ts'],
      outdir: './build',
      sourcemap: 'linked',
      minify: true,
    })
    if (!result.success) {
      if (!lastBuildFailed) {
        console.error('Build to /build failed')
        for (const message of result.logs) {
          console.error(message)
        }
      }
      lastBuildFailed = true
      return
    }
    result = await Bun.build({
      entrypoints: ['./src/index.ts'],
      outdir: './dist',
      sourcemap: 'linked',
      minify: true,
    })
    if (!result.success) {
      if (!lastBuildFailed) {
        console.error('Build to /dist failed')
        for (const message of result.logs) {
          console.error(message)
        }
      }
      lastBuildFailed = true
      return
    }
    await $`cp -a ${PUBLIC_DIR}/. ${DIST_DIR}/`.text()
    await $`rm ${DIST_DIR}/index.html`
    console.timeEnd('build')

    // Show bundle size with gzip
    const bundlePath = path.join(DIST_DIR, 'index.js')
    try {
      const bundleContent = readFileSync(bundlePath)
      const gzipped = gzipSync(bundleContent)
      const rawSize = (bundleContent.length / 1024).toFixed(1)
      const gzipSize = (gzipped.length / 1024).toFixed(1)
      console.log(`  index.js: ${rawSize} KB (${gzipSize} KB gzipped)`)
    } catch (e) {
      // Ignore if file doesn't exist
    }

    if (lastBuildFailed) {
      console.log('Build recovered')
    }
    lastBuildFailed = false
  } finally {
    isBuilding = false
    if (buildQueued) {
      buildQueued = false
      build()
    }
  }
}

watch('./src').on('change', build)

build()

function serveFromDir(config: {
  directory: string
  path: string
}): Response | null {
  let basePath = path.join(config.directory, config.path)
  const suffixes = ['', '.html', 'index.html']

  for (const suffix of suffixes) {
    try {
      const pathWithSuffix = path.join(basePath, suffix)
      const stat = statSync(pathWithSuffix)
      if (stat && stat.isFile()) {
        return new Response(Bun.file(pathWithSuffix))
      }
    } catch (err) {}
  }

  return null
}

const server = Bun.serve({
  port: 8020,
  tls: {
    key: Bun.file('./tls/key.pem'),
    cert: Bun.file('./tls/certificate.pem'),
  },
  fetch(request) {
    let reqPath = new URL(request.url).pathname
    console.log(request.method, reqPath)
    if (reqPath === '/') reqPath = '/index.html'

    // check public
    const publicResponse = serveFromDir({
      directory: PUBLIC_DIR,
      path: reqPath,
    })
    if (publicResponse) return publicResponse

    // check /.build
    const buildResponse = serveFromDir({ directory: BUILD_DIR, path: reqPath })
    if (buildResponse) return buildResponse

    if (isSPA) {
      const spaResponse = serveFromDir({
        directory: PUBLIC_DIR,
        path: '/index.html',
      })
      console.log(spaResponse)
      if (spaResponse) return spaResponse
    }
    return new Response('File not found', {
      status: 404,
    })
  },
})

console.log(`Listening on https://localhost:${server.port}`)
