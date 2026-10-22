import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mapEvent } from './events.ts';

const callbacks = () => {
    const listeners = [];
    return { on: fn => listeners.push(fn), emit: payload => listeners.forEach(fn => fn(payload)) };
};
const disconnect = callbacks(), prompt = callbacks(), location = callbacks(), areasLoaded = callbacks();
const aliases = new Map(), triggers = new Map(), messages = [], changes = [], rooms = [];
const area = { id: 'area', name: 'Area', room: number => rooms.find(room => room.roomNumber === number) };
const matching = (title, description) => rooms.filter(room => room.title === title && room.description === description);
const layoutFunctions = ['planAreaChange', 'loadLayoutModel', 'planLayoutModel', 'layoutSnapshotKey',
    'chooseProjectedConstraint', 'inferElevationPreference', 'materializePlannedLayoutModels',
    'measureIntegralLayoutQuality', 'compareLayoutQuality'];
const mocks = {
    core: { mapper: {
        getCurrentLocation() {}, getAreaById: () => area, setCurrentLocation() {},
        listRoomsByTitleDescriptionAndVisibleExits: matching, listRoomsByTitleAndDescription: matching,
    }, createAlias: (pattern, run, options) => aliases.set(options.name, { pattern: new RegExp(pattern), run }),
    createTrigger: (pattern, run, options) => triggers.set(options.name, { pattern, run }),
    createHotkey() {}, send() {}, sendRaw() {}, capture() {}, getSessions: () => [], session: {},
    echo: message => messages.push(message), buffer: {}, line: {} },
    params: { get: key => key === 'noteLinkPromptHint' ? false : undefined },
    sys: { disconnect }, map: { room: location, areasLoaded }, prompt,
    widgets: { extractMarkdownLinks: () => [] }, widget: { requestExistingRoomConnection() {} },
    polish: { startPolish() {}, stopPolish() {} },
    layout: { ...Object.fromEntries(layoutFunctions.map(name => [name, () => { throw Error(`Unexpected ${name}`); }])),
        DIRECTIONAL_VIOLATION_WEIGHT: 1, LEVEL_VIOLATION_WEIGHT: 1 },
};
globalThis.__roomChangeFlow = mocks;
const names = new Map([['smudgy:core', 'core'], ['smudgy:params', 'params'],
    ['smudgy:events/sys', 'sys'], ['smudgy:events/map', 'map'],
    ['smudgy:events/kapusniak/arctic-prompt/prompt', 'prompt'], ['smudgy:widgets', 'widgets'],
    ['./widget.tsx', 'widget'], ['./polish.ts', 'polish'], ['smudgy:@map-layout', 'layout']]);
registerHooks({
    resolve(specifier, context, next) {
        const name = names.get(specifier);
        return name ? { url: `room-change-flow:${name}`, shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
        if (url.startsWith('room-change-flow:')) {
            const name = url.slice('room-change-flow:'.length);
            const source = name === 'prompt' ? 'export default globalThis.__roomChangeFlow.prompt;'
                : Object.keys(mocks[name]).map(key => `export const ${key} = globalThis.__roomChangeFlow.${name}.${key};`).join('\n');
            return { format: 'module', source, shortCircuit: true };
        }
        if (/\/(mapper|alias)\.ts$/.test(url)) return { format: 'module', shortCircuit: true,
            source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }) };
        return next(url, context);
    },
});
const { state, State } = await import('./mapper.ts');
await import('./alias.ts');
mapEvent.on('roomChanged', change => changes.push(change));
const settle = () => new Promise(resolve => setImmediate(resolve));
function addRoom(title, description = 'Description') {
    const room = { title, description, areaId: 'area', roomNumber: rooms.length + 1,
        x: rooms.length, y: 0, level: 0, exits: [], hasTag: () => false };
    rooms.push(room);
    return room;
}
function link(from, to, direction = 'North') {
    from.exits.push({ fromDirection: direction, toAreaId: 'area', toRoomNumber: to.roomNumber });
}
function move(command) {
    const alias = aliases.get('mapper_captureMovements');
    const match = alias.pattern.exec(command);
    assert.ok(match, command);
    alias.run(Object.fromEntries(Object.entries(match.groups).map(([key, value]) => [key, value ?? ''])));
}
function see(title, extra = {}) {
    mapEvent.emit('room', { title, description: ['Description'], exits: '', objects: [], mobs: [],
        line_number: 1, prompt_line_number: 2, prompt: '', ...extra });
}
function unseen() { mapEvent.emit('visionFailed'); }
function endPrompt(exits = '') { prompt.emit({ exits }); }
beforeEach(async () => {
    disconnect.emit({});
    rooms.length = 0; messages.length = 0; changes.length = 0;
    const start = addRoom('Hall');
    state.state = State.Following; state.area = area; state.room = start;
    see('Hall');
    await settle();
    assert.deepEqual(changes, []);
});

test('look and changing contents/doors preserve the room; directions emit a mapped address', async () => {
    const next = addRoom('Hall');
    link(rooms[0], next);
    move('look'); see('Hall', { objects: ['a corpse'], mobs: ['a guard'], exits: '(N)' });
    await settle();
    assert.deepEqual(changes, []);
    move('n'); see('Hall');
    await settle();
    assert.deepEqual(changes, [{ mapped: true, areaId: 'area', roomNumber: 2, title: 'Hall' }]);
    move('look'); see('Hall');
    await settle();
    assert.equal(changes.length, 1);
    assert.deepEqual(messages, []);
});

test('each identical unmapped room counts, while unmapped looks do not', async () => {
    move('n'); see('Wilderness');
    await settle();
    assert.equal(state.room, null);
    move('look'); see('Wilderness');
    move('n'); see('Wilderness');
    await settle();
    assert.deepEqual(changes.map(change => change.mapped), [false, false]);
    assert.ok(changes.every(change => change.areaId === null && change.roomNumber === null));
});

test('failed moves and mapped self-loops do not emit', async () => {
    move('n'); mapEvent.emit('moveFailed');
    move('look'); see('Hall');
    await settle();
    link(rooms[0], rooms[0]);
    move('n'); see('Hall');
    await settle();
    assert.deepEqual(changes, []);
});

test('a later failure cannot steal an earlier room response while map work is queued', async () => {
    move('n'); move('e');
    see('Wilderness');
    mapEvent.emit('moveFailed');
    move('look'); see('Wilderness');
    await settle();
    assert.equal(changes.length, 1);
    assert.deepEqual(state.moveQueue, []);
});

test('darkness and blindness follow mapped exits, then keep emitting off the map', async () => {
    link(rooms[0], addRoom('Dark cave'));
    move('n'); unseen(); endPrompt();
    await settle();
    assert.deepEqual(changes, [{ mapped: true, areaId: 'area', roomNumber: 2, title: null }]);
    move('n'); unseen(); endPrompt();
    await settle();
    assert.equal(state.room, null, 'do not keep using the last mapped room after leaving it');
    move('n'); unseen(); endPrompt();
    await settle();
    assert.deepEqual(changes.map(change => change.mapped), [true, false, false]);
});

test('multiple unseen moves before one prompt are not collapsed', async () => {
    move('n'); move('n'); unseen(); unseen(); endPrompt();
    await settle();
    assert.equal(changes.length, 2);
    assert.ok(changes.every(change => !change.mapped && change.title === null));
    move('look'); unseen(); endPrompt();
    move('n'); mapEvent.emit('moveFailed'); endPrompt();
    await settle();
    assert.equal(changes.length, 2);
});

test('following while blind uses the captured direction', async () => {
    const trigger = triggers.get('mapper_captureFollowMove');
    trigger.run({ dir: 'north' });
    unseen(); endPrompt();
    await settle();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].mapped, false);
});

test('movement detection remains active with mapping off', async () => {
    state.state = State.Off;
    move('n'); see('Hall');
    move('look'); see('Hall');
    await settle();
    move('n'); unseen(); endPrompt();
    await settle();
    assert.equal(changes.length, 2);
    assert.ok(changes.every(change => !change.mapped));
});

test('map refreshes, editor location events and late map loading do not emit', async () => {
    location.emit({ areaId: 'area', roomNumber: 1 });
    move('look'); see('Hall');
    await settle();
    move('n'); see('New area');
    await settle();
    addRoom('New area');
    areasLoaded.emit({ areaIds: ['area'] });
    await settle();
    assert.equal(state.room.roomNumber, 2);
    assert.equal(changes.length, 1);
    move('look'); see('New area');
    await settle();
    assert.equal(changes.length, 1);
});

test('an unsolicited room description detects relocation; disconnect drops queued old rooms', async () => {
    see('Teleported');
    await settle();
    assert.equal(changes.length, 1);
    move('n'); see('Old pending room');
    disconnect.emit({});
    await settle();
    see('New session');
    await settle();
    assert.equal(changes.length, 1);
});

test('late maps cannot relocate us to the last visible room after an unseen move', async () => {
    move('n'); unseen(); endPrompt();
    await settle();
    assert.equal(state.room, null);
    areasLoaded.emit({ areaIds: ['area'] });
    await settle();
    assert.equal(state.room, null);
    assert.equal(changes.length, 1);
});

test('a self-loop discovered by late map loading still does not count as movement', async () => {
    move('n'); see('New area');
    await settle();
    const room = addRoom('New area');
    link(room, room);
    areasLoaded.emit({ areaIds: ['area'] });
    await settle();
    move('n'); see('New area');
    await settle();
    assert.equal(changes.length, 1);
});
