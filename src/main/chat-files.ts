import { open, readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

export type PreparedChatFile = {
  name: string
  size: number
  content?: string
  note?: string
}

const MAX_EXTRACTED = 30000

export async function prepareChatFile(
  path: string,
  name: string,
  size: number,
): Promise<PreparedChatFile> {
  const ext = extname(name).toLowerCase()
  if (/\.(png|jpe?g|webp)$/i.test(name))
    return { name, size, note: '图片已作为图像附件提供，可以直接分析画面。' }
  try {
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path })
      return result.value.trim()
        ? {
            name,
            size,
            content: result.value.slice(0, MAX_EXTRACTED),
            note: result.value.length > MAX_EXTRACTED ? '只提取了文件开头部分。' : undefined,
          }
        : { name, size, note: 'DOCX 未提取到文字。' }
    }
    if (ext === '.pdf') {
      const loading = getDocument({
        data: new Uint8Array(await readFile(path)),
        useSystemFonts: true,
      })
      const document = await loading.promise
      try {
        const pages: string[] = []
        for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 30); pageNumber++) {
          const page = await document.getPage(pageNumber)
          const content = await page.getTextContent()
          pages.push(
            content.items
              .map((item) => ('str' in item ? item.str : ''))
              .filter(Boolean)
              .join(' '),
          )
          if (pages.join('\n').length >= MAX_EXTRACTED) break
        }
        const extracted = pages.join('\n').slice(0, MAX_EXTRACTED)
        return extracted
          ? {
              name,
              size,
              content: extracted,
              note: document.numPages > pages.length ? '只提取了前面部分页面。' : undefined,
            }
          : { name, size, note: 'PDF 未提取到文字，可能是扫描件。' }
      } finally {
        await loading.destroy()
      }
    }
    const handle = await open(path, 'r')
    try {
      const limit = Math.min(size, 256 * 1024)
      const buffer = Buffer.alloc(limit)
      const { bytesRead } = await handle.read(buffer, 0, limit, 0)
      const sample = buffer.subarray(0, bytesRead)
      let content = ''
      if (sample[0] === 0xff && sample[1] === 0xfe)
        content = new TextDecoder('utf-16le', { fatal: true }).decode(sample.subarray(2))
      else if (!sample.includes(0))
        content = new TextDecoder('utf-8', { fatal: true }).decode(sample)
      return content.trim()
        ? {
            name,
            size,
            content: content.slice(0, MAX_EXTRACTED),
            note:
              size > bytesRead || content.length > MAX_EXTRACTED
                ? '只提取了文件开头部分。'
                : undefined,
          }
        : { name, size, note: '文件不是可直接读取的文本格式。' }
    } finally {
      await handle.close()
    }
  } catch {
    return { name, size, note: '此格式无法提取内容，或文件受密码保护。' }
  }
}
