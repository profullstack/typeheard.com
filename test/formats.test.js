import { expect, test } from 'bun:test';
import {
  billableMinutes,
  cleanSegments,
  clock,
  paragraphs,
  render,
  stamp,
} from '../packages/transcribe/src/index.js';

const segments = [
  { start: 0, end: 2.5, text: 'And so, my fellow Americans,' },
  { start: 2.5, end: 5.04, text: 'ask not what your country can do for you,' },
  { start: 9.1, end: 11, text: 'ask what you can do for your country.' },
];

test('timestamps are what players expect', () => {
  expect(stamp(0)).toBe('00:00:00,000');
  expect(stamp(3723.4567)).toBe('01:02:03,457');
  expect(stamp(59.9996, '.')).toBe('00:01:00.000');
  expect(clock(65)).toBe('01:05');
  expect(clock(3725)).toBe('1:02:05');
});

test('a pause starts a new paragraph', () => {
  const p = paragraphs(segments);
  expect(p).toHaveLength(2);
  expect(p[0].text).toBe('And so, my fellow Americans, ask not what your country can do for you,');
  expect(p[1].start).toBe(9.1);
});

test('srt and vtt are numbered and stamped', () => {
  const srt = render('srt', { segments });
  expect(srt.startsWith('1\n00:00:00,000 --> 00:00:02,500\nAnd so')).toBe(true);
  expect(srt).toContain('\n3\n00:00:09,100 --> 00:00:11,000\n');
  const vtt = render('vtt', { segments });
  expect(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:02.500\n')).toBe(true);
});

test('markdown carries a timestamp per paragraph and says when it is only a preview', () => {
  const md = render('md', { segments, title: 'JFK', durationSec: 600, transcribedSec: 180 });
  expect(md).toContain('# JFK');
  expect(md).toContain('> Preview: the first 03:00 of 10:00.');
  expect(md).toContain('**[00:09]** ask what you can do');
  expect(render('md', { segments, durationSec: 11, transcribedSec: 11 })).not.toContain('Preview');
});

test('json round-trips and txt is plain paragraphs', () => {
  expect(JSON.parse(render('json', { segments, durationSec: 11 })).segments).toHaveLength(3);
  expect(render('txt', { segments }).split('\n\n')).toHaveLength(2);
  expect(() => render('docx', { segments })).toThrow('unknown format');
});

test('what whisper emits that is not speech is dropped', () => {
  const out = cleanSegments([
    { start: 0, end: 1, text: ' [BLANK_AUDIO] ' },
    { start: 1, end: 2, text: '(music)' },
    { start: 2, end: 3, text: '♪ ♪' },
    { start: 3, end: 4, text: '  Hello   there ' },
  ]);
  expect(out).toEqual([{ start: 3, end: 4, text: 'Hello there' }]);
});

test('minutes are billed rounded up, never zero', () => {
  expect(billableMinutes(1)).toBe(1);
  expect(billableMinutes(60)).toBe(1);
  expect(billableMinutes(61)).toBe(2);
  expect(billableMinutes(3599)).toBe(60);
});
