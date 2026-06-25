import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Critter } from '/game/Critter.js';
import { WORLD } from '/game/config.js';

test('critter constructs with sensible defaults', () => {
  const c = new Critter(100, 100, 'blob');
  assert.equal(c.state, 'idle');
  assert.equal(c.species, 'blob');
  assert.ok(c.radius > 0);
  assert.ok(c.id.startsWith('c'));
});

test('critter wanders (moves) and stays within world bounds', () => {
  const c = new Critter(WORLD.width / 2, WORLD.height / 2, 'sprout');
  const startX = c.x, startY = c.y;
  let now = 0;
  for (let i = 0; i < 600; i++) { now += 16; c.update(0.016, now); }
  const moved = Math.hypot(c.x - startX, c.y - startY);
  assert.ok(moved > 1, 'critter should have moved');
  assert.ok(c.x >= 0 && c.x <= WORLD.width, 'x in bounds');
  assert.ok(c.y >= 0 && c.y <= WORLD.height, 'y in bounds');
});

test('scene + renderer modules import without DOM errors', async () => {
  await import('/game/scenes/GardenScene.js');
  await import('/game/scenes/TitleScene.js');
  await import('/game/GardenRenderer.js');
});
