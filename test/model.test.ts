import { describe, expect, test } from 'bun:test'
import { dominantModel, modelClass, modelDrift, modelFamily, modelLabel, orderModels, tallyModels } from '../src/model'

describe('model identity', () => {
  test('the label drops the ceremony and keeps the generation', () => {
    expect(modelLabel('claude-opus-5')).toBe('opus-5')
    expect(modelLabel('claude-opus-4-8')).toBe('opus-4.8')
    expect(modelLabel('claude-fable-5-1')).toBe('fable-5.1')
    // a dated id loses the date, not the version
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('haiku-4.5')
    // a context tag is part of what ran, so it stays
    expect(modelLabel('claude-opus-5[1m]')).toBe('opus-5[1m]')
    // anything that is not a family-version pair passes through untouched
    expect(modelLabel('<synthetic>')).toBe('<synthetic>')
    expect(modelLabel(null)).toBe('?')
  })

  test('hue is the family, and an unknown id gets the neutral one', () => {
    expect(modelFamily('claude-opus-4-8')).toBe('opus')
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(modelFamily('claude-fable-5-1')).toBe('fable')
    expect(modelFamily('claude-opus-5[1m]')).toBe('opus')
    expect(modelFamily('gpt-9')).toBe('other')
    expect(modelFamily(null)).toBe('other')
    // generations of one family share the hue — the label carries the rest
    expect(modelClass('claude-opus-5')).toBe(modelClass('claude-opus-4-8'))
    expect(modelClass('claude-fable-5')).toBe('m-fable')
  })

  test('the dominant model is the one that served the most requests, ties by id', () => {
    expect(dominantModel([{ model: 'claude-fable-5', requests: 3 }, { model: 'claude-opus-5', requests: 9 }])).toBe('claude-opus-5')
    expect(dominantModel([{ model: 'claude-opus-5', requests: 2 }, { model: 'claude-fable-5', requests: 2 }])).toBe('claude-fable-5')
    expect(dominantModel([])).toBeNull()
    expect(dominantModel(null)).toBeNull()
  })

  test('a tally counts served models, heaviest first, nulls dropped', () => {
    expect(tallyModels(['claude-opus-5', null, 'claude-fable-5', 'claude-opus-5', undefined])).toEqual([
      { model: 'claude-opus-5', requests: 2 },
      { model: 'claude-fable-5', requests: 1 },
    ])
    expect(tallyModels([])).toEqual([])
    expect(orderModels([{ model: 'b', requests: 1 }, { model: 'a', requests: 1 }])[0]!.model).toBe('a')
  })

  test('drift is the served model not containing the requested alias — and is unknowable without one', () => {
    // asked opus, served an opus generation: no drift
    expect(modelDrift('opus', 'claude-opus-4-8')).toBe(false)
    // the failure the fan-out rules exist to catch
    expect(modelDrift('sonnet', 'claude-fable-5')).toBe(true)
    // no parameter passed (a defined agent pinning its own model) — not a verdict
    expect(modelDrift(null, 'claude-sonnet-5')).toBeNull()
    expect(modelDrift('sonnet', null)).toBeNull()
  })
})
