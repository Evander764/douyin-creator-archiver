import test from 'node:test';
import assert from 'node:assert/strict';
import { itemMatchesExcludedTerms } from '../src/douyin.js';

test('Liu Siyi content exclusion matches author and title terms without excluding unrelated creators', () => {
  const terms = ['刘思毅', '群响刘老板'];
  assert.equal(itemMatchesExcludedTerms({ author_name: '群响刘思毅', title: '年入百万' }, terms), true);
  assert.equal(itemMatchesExcludedTerms({ author_name: '转载号', title: '#群响刘老板 创业分享' }, terms), true);
  assert.equal(itemMatchesExcludedTerms({ author_name: '普通创业者', title: '个人IP方法' }, terms), false);
});
