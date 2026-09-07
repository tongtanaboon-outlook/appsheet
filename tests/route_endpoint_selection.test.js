const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function point(id, latitude, longitude) {
  return {
    id,
    name: `Point ${id}`,
    original: { lat: latitude, lng: longitude },
    forApi: { location: { latLng: { latitude, longitude } } },
    isDepot: id === 0
  };
}

function loadRoutingFunctions(distanceByDestinationLatitude, requestedDestinations) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'OPTIMIZED ROUTING SCRIPT PRO VERSION.gs'),
    'utf8'
  );
  const sandbox = {
    JSON,
    Number,
    Logger: { log() {} },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => 'test-key' })
    },
    UrlFetchApp: {
      fetch: (_url, options) => {
        const payload = JSON.parse(options.payload);
        const destinationLatitude = payload.destination.location.latLng.latitude;
        requestedDestinations.push(destinationLatitude);
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            routes: [{
              distanceMeters: distanceByDestinationLatitude[destinationLatitude],
              optimizedIntermediateWaypointIndex: [1, 0]
            }]
          })
        };
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test('chooses the candidate endpoint with the smallest API route distance', () => {
  const requestedDestinations = [];
  const sandbox = loadRoutingFunctions(
    { 11: 18000, 12: 9000, 13: 12000 },
    requestedDestinations
  );
  const result = sandbox.findShortestRouteAcrossAllFinalDestinations([
    point(0, 10, 100),
    point(1, 11, 101),
    point(2, 12, 102),
    point(3, 13, 103)
  ]);

  assert.deepEqual(requestedDestinations, [11, 12, 13]);
  assert.equal(result.finalDestination.id, 2);
  assert.equal(result.totalDistance, 9);
  assert.deepEqual(Array.from(result.orderedWaypoints, item => item.id), [0, 3, 1, 2]);
});

test('keeps the lowest point ID when candidate routes have equal distances', () => {
  const requestedDestinations = [];
  const sandbox = loadRoutingFunctions({ 11: 9000, 12: 9000 }, requestedDestinations);
  const result = sandbox.findShortestRouteAcrossAllFinalDestinations([
    point(0, 10, 100),
    point(1, 11, 101),
    point(2, 12, 102)
  ]);

  assert.equal(result.finalDestination.id, 1);
  assert.deepEqual(requestedDestinations, [11, 12]);
});
