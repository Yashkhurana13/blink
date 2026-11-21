import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessages } from './prompt.ts';

test('a new app sends the prompt as a user message', () => {
  assert.deepEqual(buildMessages('a snake game'), [{ role: 'user', content: 'a snake game' }]);
});

test('a remix includes the complete current app and the specified change instructions', () => {
  assert.deepEqual(buildMessages('make it blue', '<html>old app</html>'), [{
    role: 'user',
    content: 'Here is the current app:\n<html>old app</html>\n\nChange it: make it blue. Return the complete updated HTML file.',
  }]);
});
