import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningEfforts, normalizeReasoningEffort, validateReasoningEffort } from '../src/model-options.mjs';

test('known GPT 6.1 Sol options apply only to an already supplied model', () => {
  assert.deepEqual(reasoningEfforts(null), []);
  assert.deepEqual(reasoningEfforts({ id: 'gpt-6.1-sol' }), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(reasoningEfforts({ id: 'gpt-6.1-sol-2026-10-01' }), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(reasoningEfforts({ id: 'unlisted-future-model' }), []);
  assert.deepEqual(reasoningEfforts({ id: 'gpt-6.1-sol-imitation', supportedReasoningEfforts: [] }), []);
});

test('returned effort metadata takes precedence and filters duplicate or unknown values', () => {
  assert.deepEqual(reasoningEfforts({ id: 'gpt-6.1-sol', supportedReasoningEfforts: ['low', 'high', 'low', 'invented'] }), ['low', 'high']);
  assert.deepEqual(reasoningEfforts({ id: 'account-model', supported_reasoning_efforts: [{ reasoning_effort: 'high' }, { effort: 'max' }, null] }), ['high', 'max']);
  assert.deepEqual(reasoningEfforts({ id: 'runtime-model', supportedEffortLevels: ['medium', 'xhigh'] }), ['medium', 'xhigh']);
});

test('normalization keeps an available choice and clears a choice removed by the current catalog', () => {
  const model = { id: 'account-model', supportedReasoningEfforts: ['low', 'high'] };
  assert.equal(normalizeReasoningEffort(model, 'high'), 'high');
  assert.equal(normalizeReasoningEffort(model, 'max'), '');
  assert.equal(normalizeReasoningEffort(undefined, 'high'), '');
});

test('unrecognized effort inputs are rejected without silently selecting another level', () => {
  assert.equal(validateReasoningEffort('high'), 'high');
  assert.equal(validateReasoningEffort(undefined), '');
  assert.equal(validateReasoningEffort(''), '');
  for (const value of ['High', 'HIGH', 'automatic', {}, 1, ' high ', 'high\n']) assert.throws(() => validateReasoningEffort(value), /supported reasoning effort/);
});
