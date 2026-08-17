mapboxgl.accessToken = 'pk.eyJ1IjoibWFyay10ZWUiLCJhIjoiY21zN2l3cHk2MDRjazM5cGxpc2hnbmY1cSJ9.VdHqEZXBn5LJ4QvFkUAtXw';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/standard',
  center: [3.82550, 7.24072],
  zoom: 16,
  pitch: 60,
  bearing: -20
});

let networkGraph = {};

const MODE_PENALTY_MULTIPLIER = 20;

let currentMode = 'walk';
let originCoord = null;
let destCoord = null;
let destName = null;

let arrivalTarget = null;

const WALK_SPEED_MPS = 1.4;
const DRIVE_SPEED_MPS = 8.3;

const NAV_ZOOM = 17;

const SNAP_RADIUS_METERS = 40;
const SNAP_MAX_CANDIDATES = 10;

let buildingList = [];

let userMarker = null;
let watchId = null;

let followMode = false;

let navigationActive = false;
let currentRoute = [];
let routeEdgeReal = [];
let turnPoints = [];

let compassActive = false;
let lastHeading = null;

let initialDirectionAnnounced = false;
let initialDirectionFallbackTimer = null;

let followResumeTimer = null;
const FOLLOW_RESUME_DELAY_MS = 4000;

let routeAnimTimer = null;
let dashStep = 0;
const dashSequence = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5]
];

let dataReady = {
  buildings: false,
  network: false,
  landmarks: false
};


function normalizeName(name) {
  if (!name) return name;
  return name.trim().replace(/\s+/g, ' ');
}


map.on('load', () => {

  map.setConfigProperty('basemap', 'show3dObjects', false);

  applyTimeOfDayLighting();
  setInterval(applyTimeOfDayLighting, 15 * 60 * 1000);

  map.addSource('campus-paths', {
    type: 'geojson',
    data: 'data/data/data/Foot_path.geojson'
  });

  map.addLayer({
    id: 'paths-line',
    type: 'line',
    source: 'campus-paths',
    paint: {
      'line-color': '#9e9e9e',
      'line-width': 3
    }
  });

  map.addSource('campus-roads', {
    type: 'geojson',
    data: 'data/data/data/Roads.geojson'
  });

  map.addLayer({
    id: 'roads-line',
    type: 'line',
    source: 'campus-roads',
    paint: {
      'line-color': '#9e9e9e',
      'line-width': 4
    }
  });

  map.addSource('route-line-source', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });

  map.addLayer({
    id: 'route-line-solid',
    type: 'line',
    source: 'route-line-source',
    filter: ['==', ['get', 'drivable'], true],
    paint: {
      'line-color': '#1565c0',
      'line-width': 6,
      'line-opacity': 0.95
    }
  });

  map.addLayer({
    id: 'route-line-dashed',
    type: 'line',
    source: 'route-line-source',
    filter: ['==', ['get', 'drivable'], false],
    paint: {
      'line-color': '#f57c00',
      'line-width': 6,
      'line-opacity': 0.95,
      'line-dasharray': [2, 2]
    }
  });

  fetch('data/data/data/Buildings.geojson')
    .then(res => {
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      return res.json();
    })
    .then(data => {
      data.features.forEach(feature => {
        feature.properties.Name = normalizeName(feature.properties.Name);
      });

      map.addSource('campus-buildings', {
        type: 'geojson',
        data: data
      });

      map.addLayer({
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'campus-buildings',
        paint: {
          'fill-extrusion-color': [
            'match', ['get', 'Name'],
            '__none__', '#8899aa',
            '#8899aa'
          ],
          'fill-extrusion-height': ['get', 'Building_H'],
          'fill-extrusion-opacity': 0.9
        }
      });

      map.on('click', 'buildings-3d', (e) => {
        if (!dataReady.buildings || !dataReady.network) return;

        const props = e.features[0].properties;
        const clickedName = normalizeName(props.Name);

        if (clickedName) {
          new mapboxgl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`<strong>${clickedName}</strong>`)
            .addTo(map);
        }

        destCoord = turf.centroid(e.features[0]).geometry.coordinates;
        destName = clickedName || null;
        document.getElementById('dest-input').value = destName || 'Selected on map';
        document.getElementById('suggestions').innerHTML = '';
        if (destName) highlightDestination(destName);
      });

      buildingList = buildingList.concat(extractNamedLocations(data));
      buildingList.sort((a, b) => a.name.localeCompare(b.name));

      const campusBbox = turf.bbox(data);
      map.fitBounds(campusBbox, { padding: 40, pitch: 60, duration: 0 });

      dataReady.buildings = true;
      checkAllDataReady();
    })
    .catch(err => {
      console.error('Failed to load Buildings.geojson:', err);
      showLoadError('Could not load building data. Please refresh, or check your connection.');
    });

  fetch('data/data/data/LandMarks.geojson')
    .then(res => {
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      return res.json();
    })
    .then(data => {
      data.features.forEach(feature => {
        feature.properties.Name = normalizeName(feature.properties.Name);
      });

      map.addSource('campus-landmarks', {
        type: 'geojson',
        data: data
      });

      map.addLayer({
        id: 'landmarks-point',
        type: 'circle',
        source: 'campus-landmarks',
        paint: {
          'circle-radius': 6,
          'circle-color': '#9b59b6',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff'
        }
      });

      map.on('click', 'landmarks-point', (e) => {
        const name = e.features[0].properties.Name || 'Unnamed landmark';
        new mapboxgl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(`<strong>${name}</strong>`)
          .addTo(map);
      });

      map.on('mouseenter', 'landmarks-point', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'landmarks-point', () => {
        map.getCanvas().style.cursor = '';
      });

      const landmarkEntries = data.features
        .filter(f => f.properties.Name)
        .map(f => ({ name: f.properties.Name, coord: f.geometry.coordinates }));

      buildingList = buildingList.concat(landmarkEntries);
      buildingList.sort((a, b) => a.name.localeCompare(b.name));

      dataReady.landmarks = true;
      checkAllDataReady();
    })
    .catch(err => {
      console.error('Failed to load LandMarks.geojson:', err);
      dataReady.landmarks = true;
      checkAllDataReady();
    });

  fetch('data/data/data/CampusNetwork.geojson')
    .then(res => {
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      return res.json();
    })
    .then(data => {
      networkGraph = buildCombinedGraph(data);

      console.log('Network graph nodes:', Object.keys(networkGraph).length);
      console.log('Network graph islands (should be 1):', countIslands(networkGraph));

      dataReady.network = true;
      checkAllDataReady();
    })
    .catch(err => {
      console.error('Failed to load CampusNetwork.geojson:', err);
      showLoadError('Could not load routing data. Please refresh, or check your connection.');
    });

  startLiveLocation();
  requestCompass();

  map.on('dragstart', () => {
    followMode = false;
    scheduleFollowResume();
  });
  map.on('zoomstart', (e) => {
    if (e.originalEvent) {
      followMode = false;
      scheduleFollowResume();
    }
  });

});

document.addEventListener('click', firstInteractionCompassRequest, { once: true });
document.addEventListener('touchstart', firstInteractionCompassRequest, { once: true });

function firstInteractionCompassRequest() {
  requestCompass();
}

window.addEventListener('resize', () => {
  map.resize();
});


function applyTimeOfDayLighting() {
  const hour = new Date().getHours();
  let preset;
  if (hour >= 5 && hour < 8) preset = 'dawn';
  else if (hour >= 8 && hour < 17) preset = 'day';
  else if (hour >= 17 && hour < 19) preset = 'dusk';
  else preset = 'night';

  map.setConfigProperty('basemap', 'lightPreset', preset);
}


function checkAllDataReady() {
  if (dataReady.buildings && dataReady.network && dataReady.landmarks) {
    document.getElementById('loading-overlay').classList.add('hidden');
    document.getElementById('dest-input').disabled = false;
    document.getElementById('search-btn').disabled = false;
    updateStatus('Search for a destination to begin.');
  }
}

function showLoadError(message) {
  document.getElementById('loading-box').innerHTML = `<p style="color:#c0392b;">${message}</p>`;
}


function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function showBuildingPhoto(name) {
  if (!name) return;

  const img = document.getElementById('photo-img');
  const caption = document.getElementById('photo-caption');
  const panel = document.getElementById('photo-preview');
  const slug = slugify(name);
  const path = `photos/${slug}.jpg`;

  img.onerror = () => {
    panel.classList.add('hidden');
  };

  img.onload = () => {
    panel.classList.remove('hidden');
  };

  caption.textContent = name;
  img.src = path;
}

document.getElementById('photo-close-btn').addEventListener('click', () => {
  document.getElementById('photo-preview').classList.add('hidden');
});


function startLineAnimation() {
  if (routeAnimTimer) return;
  routeAnimTimer = setInterval(() => {
    dashStep = (dashStep + 1) % dashSequence.length;
    if (map.getLayer('route-line-solid')) {
      map.setPaintProperty('route-line-solid', 'line-dasharray', dashSequence[dashStep]);
    }
  }, 80);
}

function stopLineAnimation() {
  if (routeAnimTimer) {
    clearInterval(routeAnimTimer);
    routeAnimTimer = null;
  }
  if (map.getLayer('route-line-solid')) {
    map.setPaintProperty('route-line-solid', 'line-dasharray', [1, 0]);
  }
}


function scheduleFollowResume() {
  if (!navigationActive) return;

  clearTimeout(followResumeTimer);
  followResumeTimer = setTimeout(() => {
    followMode = true;
    lastHeading = null;
    if (originCoord) {
      map.easeTo({ center: originCoord, zoom: NAV_ZOOM, duration: 800 });
    }
  }, FOLLOW_RESUME_DELAY_MS);
}


function highlightDestination(name) {
  map.setPaintProperty('buildings-3d', 'fill-extrusion-color', [
    'match', ['get', 'Name'],
    name, '#e63946',
    '#8899aa'
  ]);
  map.setPaintProperty('buildings-3d', 'fill-extrusion-height', [
    'match', ['get', 'Name'],
    name, ['*', ['coalesce', ['get', 'Building_H'], 3], 1.6],
    ['get', 'Building_H']
  ]);
}

function clearHighlight() {
  map.setPaintProperty('buildings-3d', 'fill-extrusion-color', '#8899aa');
  map.setPaintProperty('buildings-3d', 'fill-extrusion-height', ['get', 'Building_H']);
}


function startLiveLocation() {
  if (!navigator.geolocation) {
    updateStatus('Location is not supported on this browser.');
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const liveCoord = [position.coords.longitude, position.coords.latitude];
      originCoord = liveCoord;

      if (!userMarker) {
        const el = document.createElement('div');
        el.className = 'user-dot-wrapper';
        el.innerHTML = '<div class="user-dot-pulse"></div><div class="user-dot-core"></div>';
        userMarker = new mapboxgl.Marker({ element: el })
          .setLngLat(liveCoord)
          .addTo(map);
      } else {
        userMarker.setLngLat(liveCoord);
      }

      if (followMode) {
        const zoomTarget = navigationActive ? NAV_ZOOM : map.getZoom();
        map.easeTo({ center: liveCoord, zoom: zoomTarget, duration: 800 });
      }

      if (navigationActive) {
        checkNavigationProgress(liveCoord);
        updateRouteLineProgress(liveCoord);
      }
    },
    (error) => {
      updateStatus('Could not get your location. Check permissions and try again.');
      console.error('Geolocation error:', error);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}


function drawRouteSegmented(coordsArray, edgeRealArray) {
  const features = [];
  let groupCoords = [coordsArray[0]];
  let groupReal = edgeRealArray.length > 0 ? edgeRealArray[0] : true;

  for (let i = 0; i < edgeRealArray.length; i++) {
    if (edgeRealArray[i] === groupReal) {
      groupCoords.push(coordsArray[i + 1]);
    } else {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: groupCoords },
        properties: { drivable: groupReal }
      });
      groupCoords = [coordsArray[i], coordsArray[i + 1]];
      groupReal = edgeRealArray[i];
    }
  }

  features.push({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: groupCoords },
    properties: { drivable: groupReal }
  });

  map.getSource('route-line-source').setData({
    type: 'FeatureCollection',
    features
  });
}


function updateRouteLineProgress(liveCoord) {
  if (currentRoute.length < 2) return;

  const fullLine = turf.lineString(currentRoute);
  const userPoint = turf.point(liveCoord);
  const nearest = turf.nearestPointOnLine(fullLine, userPoint);
  const segIndex = nearest.properties.index;

  const remainingCoords = [nearest.geometry.coordinates, ...currentRoute.slice(segIndex + 1)];
  const remainingEdgeReal = routeEdgeReal.slice(segIndex);

  if (remainingCoords.length < 2) return;

  drawRouteSegmented(remainingCoords, remainingEdgeReal);

  const remainingMeters = calculateTotalDistance(remainingCoords);
  const remainingMinutes = calculateWeightedMinutes(remainingCoords, remainingEdgeReal, currentMode);

  document.getElementById('route-summary').textContent =
    `${Math.round(remainingMeters)}m • approx. ${remainingMinutes} min ${currentMode === 'walk' ? 'walk' : 'drive'}`;
}


function requestCompass() {
  if (compassActive) return;

  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(response => {
        if (response === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation, true);
          compassActive = true;
        }
      })
      .catch(err => console.error('Compass permission error:', err));
  } else {
    window.addEventListener('deviceorientation', handleOrientation, true);
    compassActive = true;
  }
}

function normalizeAngleDiff(target, current) {
  return ((target - current + 540) % 360) - 180;
}

function announceInitialDirection(currentHeading) {
  if (initialDirectionAnnounced) return;
  if (currentRoute.length < 2) return;

  const nextPoint = currentRoute[1];
  const targetBearing = turf.bearing(originCoord, nextPoint);
  const diff = normalizeAngleDiff(targetBearing, currentHeading);

  initialDirectionAnnounced = true;
  clearTimeout(initialDirectionFallbackTimer);

  if (Math.abs(diff) < 30) {
    speak('Continue straight.');
  } else if (Math.abs(diff) > 150) {
    speak('Turn around to face your route.');
  } else if (diff > 0) {
    speak('Turn right to face your route.');
  } else {
    speak('Turn left to face your route.');
  }
}

function handleOrientation(event) {
  if (!navigationActive || !followMode) return;

  let heading = event.webkitCompassHeading;
  if (heading === undefined || heading === null) {
    if (event.alpha === null) return;
    heading = 360 - event.alpha;
  }

  if (!initialDirectionAnnounced) {
    announceInitialDirection(heading);
  }

  if (lastHeading !== null) {
    let diff = Math.abs(heading - lastHeading);
    if (diff > 180) diff = 360 - diff;
    if (diff < 4) return;
  }

  lastHeading = heading;
  map.setBearing(heading);
}


function speak(text) {
  if (!window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  window.speechSynthesis.speak(utterance);
}

function computeTurnPoints(routeCoords, angleThreshold = 45, minSegmentMeters = 10) {
  const rawTurns = [];

  for (let i = 1; i < routeCoords.length - 1; i++) {
    const bearingIn = turf.bearing(routeCoords[i - 1], routeCoords[i]);
    const bearingOut = turf.bearing(routeCoords[i], routeCoords[i + 1]);

    let turnAngle = bearingOut - bearingIn;
    if (turnAngle > 180) turnAngle -= 360;
    if (turnAngle < -180) turnAngle += 360;

    if (Math.abs(turnAngle) > angleThreshold) {
      rawTurns.push({
        index: i,
        coord: routeCoords[i],
        direction: turnAngle > 0 ? 'right' : 'left'
      });
    }
  }

  const filtered = [];
  for (let k = 0; k < rawTurns.length; k++) {
    const thisTurn = rawTurns[k];
    const nextIndex = (k + 1 < rawTurns.length) ? rawTurns[k + 1].index : routeCoords.length - 1;

    let segLen = 0;
    for (let j = thisTurn.index; j < nextIndex; j++) {
      segLen += turf.distance(routeCoords[j], routeCoords[j + 1], { units: 'meters' });
    }

    if (segLen >= minSegmentMeters) {
      filtered.push({ ...thisTurn, announcedUpcoming: false, announcedNow: false });
    }
  }

  return filtered;
}

function checkNavigationProgress(liveCoord) {
  if (!arrivalTarget) return;

  const distToDest = turf.distance(liveCoord, arrivalTarget, { units: 'meters' });
  if (distToDest < 15) {
    speak('You have arrived at your destination.');
    navigationActive = false;
    stopLineAnimation();
    return;
  }

  const nextTurn = turnPoints.find(t => !t.announcedNow);
  if (!nextTurn) return;

  const distToTurn = turf.distance(liveCoord, nextTurn.coord, { units: 'meters' });

  if (distToTurn <= 5 && !nextTurn.announcedNow) {
    speak(`Turn ${nextTurn.direction} now, then continue straight.`);
    nextTurn.announcedNow = true;
  } else if (distToTurn <= 20 && !nextTurn.announcedUpcoming) {
    const roundedDist = Math.round(distToTurn / 5) * 5;
    speak(`In ${roundedDist} meters, turn ${nextTurn.direction}.`);
    nextTurn.announcedUpcoming = true;
  }
}


function extractNamedLocations(geojson) {
  const results = [];

  geojson.features.forEach(feature => {
    const name = feature.properties.Name;
    if (!name) return;

    const centroid = turf.centroid(feature);
    const coord = centroid.geometry.coordinates;

    results.push({ name, coord });
  });

  return results;
}

const destInput = document.getElementById('dest-input');
const suggestionsBox = document.getElementById('suggestions');

destInput.addEventListener('input', () => {
  const query = destInput.value.trim().toLowerCase();
  suggestionsBox.innerHTML = '';

  if (query.length === 0) {
    destCoord = null;
    destName = null;
    clearHighlight();
    return;
  }

  const matches = buildingList.filter(b => b.name.toLowerCase().includes(query)).slice(0, 6);

  matches.forEach(match => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.textContent = match.name;
    item.addEventListener('click', () => {
      destInput.value = match.name;
      destCoord = match.coord;
      destName = match.name;
      suggestionsBox.innerHTML = '';
      highlightDestination(match.name);
    });
    suggestionsBox.appendChild(item);
  });
});

document.getElementById('walk-btn').addEventListener('click', () => {
  currentMode = 'walk';
  document.getElementById('walk-btn').classList.add('active');
  document.getElementById('drive-btn').classList.remove('active');
});

document.getElementById('drive-btn').addEventListener('click', () => {
  currentMode = 'drive';
  document.getElementById('drive-btn').classList.add('active');
  document.getElementById('walk-btn').classList.remove('active');
});

document.getElementById('search-btn').addEventListener('click', () => {
  if (!originCoord) {
    updateStatus('Still finding your location — please wait a moment and try again.');
    return;
  }
  if (!destCoord) {
    updateStatus('Please select a destination from the suggestions list.');
    return;
  }

  updateStatus('Calculating route...');
  calculateAndDrawRoute();

  document.getElementById('search-controls').classList.add('hidden');
  document.getElementById('nav-controls').classList.remove('hidden');

  setTimeout(() => map.resize(), 50);
});


document.getElementById('start-nav-btn').addEventListener('click', () => {
  if (!originCoord || currentRoute.length === 0) {
    updateStatus('Waiting for your location and route...');
    return;
  }

  followMode = true;
  navigationActive = true;
  lastHeading = null;
  initialDirectionAnnounced = false;

  requestCompass();
  startLineAnimation();
  showBuildingPhoto(destName);

  map.stop();
  map.easeTo({ center: originCoord, zoom: NAV_ZOOM, duration: 800 });

  const startBtn = document.getElementById('start-nav-btn');
  startBtn.textContent = 'Navigating — follow the blue line';
  startBtn.disabled = true;
  startBtn.classList.add('is-navigating');

  document.getElementById('status-bar').classList.add('hidden');

  speak('Navigation started.');

  clearTimeout(initialDirectionFallbackTimer);
  initialDirectionFallbackTimer = setTimeout(() => {
    if (!initialDirectionAnnounced) {
      initialDirectionAnnounced = true;
      if (turnPoints.length > 0) {
        speak('Continue straight.');
      } else {
        speak('Head straight to your destination.');
      }
    }
  }, 2500);
});

document.getElementById('recenter-btn').addEventListener('click', () => {
  if (!originCoord) return;
  followMode = true;
  lastHeading = null;
  clearTimeout(followResumeTimer);
  map.stop();
  const zoomTarget = navigationActive ? NAV_ZOOM : map.getZoom();
  map.easeTo({ center: originCoord, zoom: zoomTarget, duration: 800 });
});

document.getElementById('search-again-btn').addEventListener('click', () => {
  followMode = false;
  navigationActive = false;
  currentRoute = [];
  routeEdgeReal = [];
  turnPoints = [];
  arrivalTarget = null;
  clearTimeout(followResumeTimer);
  clearTimeout(initialDirectionFallbackTimer);
  stopLineAnimation();

  document.getElementById('photo-preview').classList.add('hidden');

  const startBtn = document.getElementById('start-nav-btn');
  startBtn.textContent = 'Start Navigation';
  startBtn.disabled = true;
  startBtn.classList.remove('is-navigating');

  document.getElementById('status-bar').classList.remove('hidden');

  document.getElementById('nav-controls').classList.add('hidden');
  document.getElementById('search-controls').classList.remove('hidden');

  document.getElementById('route-summary').textContent = 'Search a destination to see distance and ETA.';

  destInput.value = '';
  destCoord = null;
  destName = null;
  clearHighlight();
  clearRoute();
  updateStatus('Search for a destination to begin.');

  setTimeout(() => map.resize(), 50);
});


function updateStatus(message) {
  document.getElementById('status').textContent = message;
}

function clearRoute() {
  map.getSource('route-line-source').setData({ type: 'FeatureCollection', features: [] });
}


function findNearestNodes(graph, coord) {
  const allCandidates = Object.keys(graph).map(nodeKey => {
    const nodeCoord = nodeKey.split(',').map(Number);
    const dist = turf.distance(coord, nodeCoord, { units: 'meters' });
    return { node: nodeCoord, dist };
  });

  allCandidates.sort((a, b) => a.dist - b.dist);

  const withinRadius = allCandidates.filter(c => c.dist <= SNAP_RADIUS_METERS);

  if (withinRadius.length >= 2) {
    return withinRadius.slice(0, SNAP_MAX_CANDIDATES);
  }

  return allCandidates.slice(0, SNAP_MAX_CANDIDATES);
}

function edgeMatchesMode(graph, coordA, coordB, mode) {
  const keyA = coordA.map(n => n.toFixed(6)).join(',');
  const neighbors = graph[keyA] || [];
  const match = neighbors.find(n =>
    n.node[0].toFixed(6) === coordB[0].toFixed(6) &&
    n.node[1].toFixed(6) === coordB[1].toFixed(6)
  );
  if (!match) return true;
  return mode === 'drive' ? match.drivable : match.walkable;
}

function buildEdgeRealArray(graph, route, mode) {
  const arr = [];
  for (let i = 0; i < route.length - 1; i++) {
    arr.push(edgeMatchesMode(graph, route[i], route[i + 1], mode));
  }
  return arr;
}

function calculateWeightedMinutes(routeCoords, edgeRealArray, mode) {
  let totalSeconds = 0;
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const dist = turf.distance(routeCoords[i], routeCoords[i + 1], { units: 'meters' });
    let speed;
    if (mode === 'drive') {
      speed = edgeRealArray[i] ? DRIVE_SPEED_MPS : WALK_SPEED_MPS;
    } else {
      speed = WALK_SPEED_MPS;
    }
    totalSeconds += dist / speed;
  }
  return Math.max(1, Math.round(totalSeconds / 60));
}

function calculateAndDrawRoute() {
  const graph = networkGraph;

  const startCandidates = findNearestNodes(graph, originCoord);
  const endCandidates = findNearestNodes(graph, destCoord);

  let bestRoute = null;
  let bestTotal = Infinity;
  let bestStartSnap = 0;
  let bestEndSnap = 0;

  startCandidates.forEach(startC => {
    endCandidates.forEach(endC => {
      const candidateRoute = findShortestPath(graph, startC.node, endC.node, currentMode);
      if (!candidateRoute) return;

      const graphDist = calculateTotalDistance(candidateRoute);
      const total = startC.dist + graphDist + endC.dist;

      if (total < bestTotal) {
        bestTotal = total;
        bestRoute = candidateRoute;
        bestStartSnap = startC.dist;
        bestEndSnap = endC.dist;
      }
    });
  });

  if (!bestRoute) {
    updateStatus('No route found for this mode. Try a different destination or mode.');
    return;
  }

  const edgeReal = buildEdgeRealArray(graph, bestRoute, currentMode);

  drawRouteSegmented(bestRoute, edgeReal);

  currentRoute = bestRoute;
  routeEdgeReal = edgeReal;
  arrivalTarget = bestRoute[bestRoute.length - 1];
  turnPoints = computeTurnPoints(bestRoute);

  const totalMeters = bestTotal;
  const minutes = calculateWeightedMinutes(bestRoute, edgeReal, currentMode);

  const hasWalkFallback = currentMode === 'drive' && edgeReal.includes(false);

  document.getElementById('route-summary').textContent =
    `${Math.round(totalMeters)}m • approx. ${minutes} min ${currentMode === 'walk' ? 'walk' : 'drive'}`;

  document.getElementById('start-nav-btn').disabled = false;
  document.getElementById('recenter-btn').disabled = false;

  if (hasWalkFallback) {
    updateStatus('Route ready. Part of this trip must be walked (shown in orange).');
  } else {
    updateStatus('Route ready. Tap Start Navigation when you\'re ready to go.');
  }
}

function calculateTotalDistance(routeCoords) {
  let total = 0;
  for (let i = 0; i < routeCoords.length - 1; i++) {
    total += turf.distance(routeCoords[i], routeCoords[i + 1], { units: 'meters' });
  }
  return total;
}


function extractAllSegments(geojson) {
  const segments = [];
  geojson.features.forEach(feature => {
    const walkable = feature.properties.walk === 1;
    const drivable = feature.properties.drive === 1;
    if (!walkable && !drivable) return;

    feature.geometry.coordinates.forEach(line => {
      for (let i = 0; i < line.length - 1; i++) {
        segments.push({ p1: line[i], p2: line[i + 1], walkable, drivable });
      }
    });
  });
  return segments;
}

function segmentBBox(seg) {
  const { p1, p2 } = seg;
  return {
    minX: Math.min(p1[0], p2[0]),
    maxX: Math.max(p1[0], p2[0]),
    minY: Math.min(p1[1], p2[1]),
    maxY: Math.max(p1[1], p2[1])
  };
}

function bboxesOverlap(a, b, pad = 0.00002) {
  return !(a.maxX + pad < b.minX || b.maxX + pad < a.minX ||
           a.maxY + pad < b.minY || b.maxY + pad < a.minY);
}

function pointsClose(a, b, epsilon = 1e-7) {
  return Math.abs(a[0] - b[0]) < epsilon && Math.abs(a[1] - b[1]) < epsilon;
}

function splitSegmentsAtIntersections(segments) {
  const splitPoints = segments.map(() => []);
  const bboxes = segments.map(segmentBBox);

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (!bboxesOverlap(bboxes[i], bboxes[j])) continue;

      const a1 = segments[i].p1, a2 = segments[i].p2;
      const b1 = segments[j].p1, b2 = segments[j].p2;

      let intersections;
      try {
        intersections = turf.lineIntersect(
          turf.lineString([a1, a2]),
          turf.lineString([b1, b2])
        );
      } catch (err) {
        continue;
      }

      intersections.features.forEach(f => {
        const pt = f.geometry.coordinates;
        const isEndpointOfI = pointsClose(pt, a1) || pointsClose(pt, a2);
        const isEndpointOfJ = pointsClose(pt, b1) || pointsClose(pt, b2);
        if (!isEndpointOfI) splitPoints[i].push(pt);
        if (!isEndpointOfJ) splitPoints[j].push(pt);
      });
    }
  }

  const finalSegments = [];
  segments.forEach((seg, idx) => {
    const { p1, p2, walkable, drivable } = seg;
    const extra = splitPoints[idx];

    if (extra.length === 0) {
      finalSegments.push({ p1, p2, walkable, drivable });
      return;
    }

    const ordered = extra
      .map(pt => ({ pt, d: turf.distance(p1, pt, { units: 'meters' }) }))
      .sort((a, b) => a.d - b.d);

    let prev = p1;
    ordered.forEach(({ pt }) => {
      if (!pointsClose(prev, pt)) {
        finalSegments.push({ p1: prev, p2: pt, walkable, drivable });
        prev = pt;
      }
    });
    if (!pointsClose(prev, p2)) {
      finalSegments.push({ p1: prev, p2, walkable, drivable });
    }
  });

  return finalSegments;
}

function buildCombinedGraph(geojson) {
  const rawSegments = extractAllSegments(geojson);
  const repairedSegments = splitSegmentsAtIntersections(rawSegments);

  const graph = {};

  function snap(coord) {
    return coord.map(n => n.toFixed(6)).join(',');
  }

  repairedSegments.forEach(({ p1, p2, walkable, drivable }) => {
    const nodeA = snap(p1);
    const nodeB = snap(p2);
    const dist = turf.distance(p1, p2, { units: 'meters' });

    if (!graph[nodeA]) graph[nodeA] = [];
    if (!graph[nodeB]) graph[nodeB] = [];

    graph[nodeA].push({ node: p2, weight: dist, walkable, drivable });
    graph[nodeB].push({ node: p1, weight: dist, walkable, drivable });
  });

  return graph;
}

function countIslands(graph) {
  const visited = new Set();
  let islands = 0;

  Object.keys(graph).forEach(startNode => {
    if (visited.has(startNode)) return;
    islands++;
    const stack = [startNode];
    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      graph[current].forEach(neighbor => {
        const neighborKey = neighbor.node.map(n => n.toFixed(6)).join(',');
        if (!visited.has(neighborKey)) stack.push(neighborKey);
      });
    }
  });

  return islands;
}

function findShortestPath(graph, startCoord, endCoord, mode) {
  const start = startCoord.map(n => n.toFixed(6)).join(',');
  const end = endCoord.map(n => n.toFixed(6)).join(',');

  const distances = {};
  const previous = {};
  const unvisited = new Set(Object.keys(graph));

  Object.keys(graph).forEach(node => { distances[node] = Infinity; });
  distances[start] = 0;

  while (unvisited.size > 0) {
    let current = null;
    let currentDist = Infinity;
    unvisited.forEach(node => {
      if (distances[node] < currentDist) {
        currentDist = distances[node];
        current = node;
      }
    });

    if (current === null || current === end) break;
    unvisited.delete(current);

    graph[current].forEach(neighbor => {
      const neighborKey = neighbor.node.map(n => n.toFixed(6)).join(',');
      const matchesMode = mode === 'drive' ? neighbor.drivable : neighbor.walkable;
      const effectiveWeight = matchesMode ? neighbor.weight : neighbor.weight * MODE_PENALTY_MULTIPLIER;

      const alt = distances[current] + effectiveWeight;
      if (alt < distances[neighborKey]) {
        distances[neighborKey] = alt;
        previous[neighborKey] = current;
      }
    });
  }

  if (distances[end] === Infinity) return null;

  const path = [end];
  let step = end;
  while (step !== start) {
    step = previous[step];
    path.unshift(step);
  }

  return path.map(n => n.split(',').map(Number));
}