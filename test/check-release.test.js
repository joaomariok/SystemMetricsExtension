const test = require('node:test');
const assert = require('node:assert/strict');
const { changelogHasVersion, publishedVersions } = require('../scripts/check-release.js');

test('changelogHasVersion matches an exact "## <version>" heading', () => {
  assert.equal(changelogHasVersion('# Changelog\n\n## 0.1.0\n\n- First release.\n', '0.1.0'), true);
  assert.equal(changelogHasVersion('# Changelog\r\n\r\n## 0.1.0\r\n', '0.1.0'), true);
});

test('changelogHasVersion rejects near misses', () => {
  assert.equal(changelogHasVersion('## 0.1.01\n', '0.1.0'), false);
  assert.equal(changelogHasVersion('## 0.1.0-beta\n', '0.1.0'), false);
  assert.equal(changelogHasVersion('### 0.1.0\n', '0.1.0'), false);
  assert.equal(changelogHasVersion('## 0x1y0\n', '0.1.0'), false);
  assert.equal(changelogHasVersion('# Changelog\n', '0.1.0'), false);
});

test('publishedVersions lists versions from a Marketplace query response', () => {
  const response = { results: [{ extensions: [{ versions: [{ version: '0.2.0' }, { version: '0.1.0' }] }] }] };
  assert.deepEqual(publishedVersions(response), ['0.2.0', '0.1.0']);
});

test('publishedVersions is empty when the extension is not on the Marketplace', () => {
  assert.deepEqual(publishedVersions({ results: [{ extensions: [] }] }), []);
  assert.deepEqual(publishedVersions({}), []);
});
