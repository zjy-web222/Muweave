import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { generateCodexImage } from '../src/main/codex-image'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
afterEach(() => vi.resetAllMocks())

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
function runtime(failure?: string) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as null | number,
    stdin: new Writable({ write(chunk, _encoding, done) {
      const request = JSON.parse(String(chunk))
      calls.push(request)
      const emit = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n')
      queueMicrotask(() => {
        if (!request.id) return
        const result = request.method === 'modelProvider/capabilities/read' ? { imageGeneration: true } :
          request.method === 'model/list' ? { data: [{ model: 'bundled-image-model', isDefault: true }] } :
          request.method === 'thread/start' ? { thread: { id: 'image-thread' } } : {}
        emit({ id: request.id, result })
        if (request.method === 'turn/start') {
          if (failure) emit({ method: 'error', params: { threadId: 'image-thread', willRetry: false,
            error: { message: failure, codexErrorInfo: 'other' } } })
          else emit({ method: 'item/completed', params: { threadId: 'image-thread',
            item: { type: 'imageGeneration', status: 'completed', result: png.toString('base64') } } })
          emit({ method: 'turn/completed', params: { threadId: 'image-thread', turn: { items: [] } } })
        }
      })
      done()
    } }),
    kill: vi.fn(() => { child.exitCode = 0; child.emit('close', 0) }),
  })
  spawn.mockReturnValue(child)
  return { child, calls }
}

it('uses the bundled default model and returns the completed PNG despite the final empty turn', async () => {
  const { child, calls } = runtime()
  await expect(generateCodexImage('codex', {}, 'cow cat', '1:1')).resolves.toEqual(png)
  expect(calls.find(c => c.method === 'thread/start')?.params).toMatchObject({ model: 'bundled-image-model' })
  expect(spawn).toHaveBeenCalledWith('codex', expect.arrayContaining(['mcp_servers={}']), expect.any(Object))
  expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(1)
  expect(child.kill).toHaveBeenCalledOnce()
})

it('shows the actual server failure and does not submit another generation', async () => {
  const { calls } = runtime('This model is not supported with this account')
  await expect(generateCodexImage('codex', {}, 'cow cat', '1:1')).rejects.toThrow('This model is not supported')
  expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(1)
})
