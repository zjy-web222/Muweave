import { describe, expect, it } from 'vitest'
import { minimumDialogueDuration, planVideoTiming } from '../src/shared/director'

describe('shared video timing preview and queue rules', () => {
  it.each(['runninghub', 'doubao', 'xai'] as const)('%s fits 11–15 second dialogue within its existing adapter limit', (provider) => {
    const dialogue = '字'.repeat(33)
    expect(minimumDialogueDuration(dialogue)).toBe(11)
    expect(planVideoTiming({ dialogue, duration: 10 }, provider))
      .toMatchObject({ required: 11, duration: 11, maximum: 15, issue: undefined })
    expect(planVideoTiming({ dialogue: '字'.repeat(49), duration: 10 }, provider))
      .toMatchObject({ required: 15, duration: 15, issue: undefined })
    expect(planVideoTiming({ dialogue, duration: 12 }, provider).duration).toBe(12)
  })
  it.each(['runninghub', 'doubao', 'xai', 'kling', 'minimax'] as const)('%s rejects dialogue or an explicit shot duration above its limit', (provider) => {
    const maximum = ['kling', 'minimax'].includes(provider) ? 10 : 15
    expect(planVideoTiming({ dialogue: '字'.repeat(50), duration: 5 }, provider))
      .toMatchObject({ required: 16, maximum, issue: 'dialogue' })
    expect(planVideoTiming({ dialogue: '', duration: maximum + 1 }, provider))
      .toMatchObject({ issue: 'duration' })
  })
  it.each([
    ['runninghub', 2, 4], ['runninghub', 6.5, 6.5],
    ['kling', 2, 5], ['kling', 6.5, 10], ['kling', 10, 10],
    ['minimax', 2, 6], ['minimax', 6.5, 10], ['minimax', 10, 10],
  ] as const)('%s previews the actual supported duration for %s seconds', (provider, duration, target) => {
    expect(planVideoTiming({ dialogue: '', duration }, provider))
      .toMatchObject({ duration: target, issue: undefined })
  })
  it.each(['kling', 'minimax'] as const)('%s still rejects 11 second dialogue, even when the shot is set longer', (provider) => {
    expect(planVideoTiming({ dialogue: '字'.repeat(33), duration: 12 }, provider))
      .toMatchObject({ required: 11, maximum: 10, issue: 'dialogue' })
  })
})
