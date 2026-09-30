import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { unzipSync } from 'fflate'

if (process.platform !== 'win32') process.exit(0)

const version = '8.1.2'
const archiveSha256 = 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec'
const url = `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${version}-essentials_build.zip`
const root = resolve('vendor/ffmpeg')
const ffmpeg = join(root, 'ffmpeg.exe')
const ffprobe = join(root, 'ffprobe.exe')
const license = join(root, 'LICENSE')
if (existsSync(ffmpeg) && existsSync(ffprobe) && existsSync(license)) process.exit(0)

mkdirSync(root, { recursive: true })
try {
  const installed = execFileSync('where.exe', ['ffmpeg'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
  const installedProbe = join(dirname(installed), 'ffprobe.exe')
  const build = execFileSync(installed, ['-version'], { encoding: 'utf8' })
  const installedLicense = join(dirname(installed), '..', 'LICENSE')
  if (installed.includes('Gyan.FFmpeg') && existsSync(installedProbe) && existsSync(installedLicense) && build.includes('--enable-libx264')) {
    copyFileSync(installed, ffmpeg)
    copyFileSync(installedProbe, ffprobe)
    copyFileSync(installedLicense, license)
    writeFileSync(join(root, 'NOTICE.txt'),
      `${build.split(/\r?\n/)[0]}\nSource: https://www.gyan.dev/ffmpeg/builds/\nFFmpeg source and license: https://ffmpeg.org/legal.html\n`,
    )
    console.log('Bundled locally installed FFmpeg tools are ready.')
    process.exit(0)
  }
} catch { /* Fall back to the pinned download. */ }

const archive = join(root, `ffmpeg-${version}.zip`)
if (existsSync(archive) && createHash('sha256').update(readFileSync(archive)).digest('hex') !== archiveSha256)
  rmSync(archive)
if (!existsSync(archive)) {
  console.log(`Downloading FFmpeg ${version} for the Windows app…`)
  execFileSync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--max-time', '300', '--output', archive, url], {
    stdio: 'inherit',
  })
}
const bytes = readFileSync(archive)
const actual = createHash('sha256').update(bytes).digest('hex')
if (actual !== archiveSha256) throw new Error('FFmpeg archive checksum mismatch')
const contents = unzipSync(bytes, {
  filter: (file) => /\/bin\/(ffmpeg|ffprobe)\.exe$/i.test(file.name) || /\/LICENSE$/i.test(file.name),
})
for (const [name, content] of Object.entries(contents)) {
  const base = name.split('/').at(-1)
  if (base === 'ffmpeg.exe' || base === 'ffprobe.exe') writeFileSync(join(root, base), content)
  if (base === 'LICENSE') writeFileSync(license, content)
}
if (!existsSync(ffmpeg) || !existsSync(ffprobe) || !existsSync(license)) throw new Error('FFmpeg archive lacks required binaries or license')
writeFileSync(join(root, 'NOTICE.txt'),
  `FFmpeg ${version} essentials build by Gyan Doshi\n${url}\nSHA-256: ${archiveSha256}\nFFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/n${version}\nLicense information: https://ffmpeg.org/legal.html\n`,
)
console.log('Bundled FFmpeg tools are ready.')
