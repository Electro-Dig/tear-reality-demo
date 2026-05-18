export function createClothMesh({ width, height, columns = 56, rows = 32, irregularity = 0 }) {
  const particles = [];
  const constraints = [];
  const indexFor = (x, y) => y * (columns + 1) + x;
  const cellWidth = width / columns;
  const cellHeight = height / rows;

  for (let y = 0; y <= rows; y += 1) {
    for (let x = 0; x <= columns; x += 1) {
      const u = x / columns;
      const v = y / rows;
      const pinned = x === 0 || y === 0 || x === columns || y === rows;
      const offsetXFactor = pinned ? 0 : noise2d(x, y, 17);
      const offsetYFactor = pinned ? 0 : noise2d(x, y, 41);
      const px = u * width + offsetXFactor * cellWidth * irregularity;
      const py = v * height + offsetYFactor * cellHeight * irregularity;
      particles.push({
        x: px,
        y: py,
        oldX: px,
        oldY: py,
        u,
        v,
        pinX: px,
        pinY: py,
        offsetXFactor,
        offsetYFactor,
        pinned,
      });
    }
  }

  const addConstraint = (a, b, stiffness = 1) => {
    const pa = particles[a];
    const pb = particles[b];
    constraints.push({
      a,
      b,
      rest: Math.hypot(pb.x - pa.x, pb.y - pa.y),
      stiffness,
      broken: false,
      damage: 0,
    });
  };

  for (let y = 0; y <= rows; y += 1) {
    for (let x = 0; x <= columns; x += 1) {
      if (x < columns) addConstraint(indexFor(x, y), indexFor(x + 1, y), 0.92);
      if (y < rows) addConstraint(indexFor(x, y), indexFor(x, y + 1), 0.92);
      if (x < columns && y < rows) {
        addConstraint(indexFor(x, y), indexFor(x + 1, y + 1), 0.35);
        addConstraint(indexFor(x + 1, y), indexFor(x, y + 1), 0.35);
      }
    }
  }

  return {
    width,
    height,
    columns,
    rows,
    irregularity,
    particles,
    constraints,
    grabbed: [],
    pointer: null,
    brokenCount: 0,
    active: false,
  };
}

export function resizeClothMesh(mesh, width, height) {
  const sx = width / mesh.width;
  const sy = height / mesh.height;
  mesh.width = width;
  mesh.height = height;
  const cellWidth = width / mesh.columns;
  const cellHeight = height / mesh.rows;
  for (const particle of mesh.particles) {
    particle.x *= sx;
    particle.y *= sy;
    particle.oldX *= sx;
    particle.oldY *= sy;
    particle.pinX = particle.u * width + particle.offsetXFactor * cellWidth * mesh.irregularity;
    particle.pinY = particle.v * height + particle.offsetYFactor * cellHeight * mesh.irregularity;
  }
  for (const constraint of mesh.constraints) {
    const a = mesh.particles[constraint.a];
    const b = mesh.particles[constraint.b];
    constraint.rest = Math.hypot(b.pinX - a.pinX, b.pinY - a.pinY);
  }
}

export function beginGrab(mesh, point, radius = 120) {
  const picked = [];
  let nearest = null;
  let nearestDistance = Infinity;

  mesh.particles.forEach((particle, index) => {
    const distance = Math.hypot(particle.x - point.x, particle.y - point.y);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
    if (!particle.pinned && distance <= radius) {
      picked.push({
        index,
        offsetX: particle.x - point.x,
        offsetY: particle.y - point.y,
        weight: 1 - distance / radius,
      });
    }
  });

  if (picked.length === 0 && nearest !== null) {
    const particle = mesh.particles[nearest];
    picked.push({ index: nearest, offsetX: particle.x - point.x, offsetY: particle.y - point.y, weight: 1 });
  }

  mesh.grabbed = picked;
  mesh.pointer = point;
  mesh.active = picked.length > 0;
}

export function moveGrab(mesh, point) {
  mesh.pointer = point;
  mesh.active = true;
}

export function releaseGrab(mesh) {
  mesh.grabbed = [];
  mesh.pointer = null;
  mesh.active = true;
}

export function stressClothMesh(mesh, from, to, radius = 48, strength = 1, options = {}) {
  let newlyBroken = 0;
  const structuralLimit = Math.max(mesh.width / mesh.columns, mesh.height / mesh.rows) * 1.18;
  const pullDistance = Math.hypot(to.x - from.x, to.y - from.y);
  if (pullDistance < (options.minSegmentLength ?? 0)) return 0;
  const speedFactor = Math.min(1.8, Math.max(0.35, pullDistance / 42));

  for (const particle of mesh.particles) {
    const distance = distanceToSegment(particle, from, to);
    if (!particle.pinned && distance <= radius * 1.7) {
      const falloff = 1 - distance / (radius * 1.7);
      const pull = falloff * speedFactor * strength * 0.27;
      particle.x += (to.x - particle.x) * pull;
      particle.y += (to.y - particle.y) * pull;
    }
  }

  for (const constraint of mesh.constraints) {
    if (constraint.broken || constraint.rest > structuralLimit) continue;
    const a = mesh.particles[constraint.a];
    const b = mesh.particles[constraint.b];
    const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
    const distance = distanceToSegment(mid, from, to);
    if (distance > radius) continue;

    const falloff = 1 - distance / radius;
    const currentLength = Math.hypot(b.x - a.x, b.y - a.y);
    const stretch = currentLength / constraint.rest;
    constraint.damage += falloff * speedFactor * strength * (stretch > 1.18 ? 0.22 : 0.07);

    if (constraint.damage > 1.45 && stretch > 1.2) {
      constraint.broken = true;
      newlyBroken += 1;
    }
  }

  mesh.brokenCount += newlyBroken;
  mesh.active = mesh.active || newlyBroken > 0;
  return newlyBroken;
}

export function cutClothMesh(mesh, from, to, radius = 24) {
  return stressClothMesh(mesh, from, to, radius, 1.2);
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return Math.hypot(point.x - x, point.y - y);
}

export function resetClothMesh(mesh) {
  for (const particle of mesh.particles) {
    particle.x = particle.pinX;
    particle.y = particle.pinY;
    particle.oldX = particle.pinX;
    particle.oldY = particle.pinY;
  }
  for (const constraint of mesh.constraints) constraint.broken = false;
  for (const constraint of mesh.constraints) constraint.damage = 0;
  mesh.grabbed = [];
  mesh.pointer = null;
  mesh.brokenCount = 0;
  mesh.active = false;
}

export function settleClothMesh(mesh, amount = 0.55) {
  for (const particle of mesh.particles) {
    particle.x += (particle.pinX - particle.x) * amount;
    particle.y += (particle.pinY - particle.y) * amount;
    particle.oldX = particle.x;
    particle.oldY = particle.y;
  }
  mesh.grabbed = [];
  mesh.pointer = null;
  mesh.active = false;
}

export function stepClothMesh(mesh, options = {}) {
  const {
    damping = 0.972,
    gravity = 0.045,
    iterations = 3,
    tearRatio = 2.55,
    grabStrength = 0.78,
    tearCenter = null,
    tearRadius = Infinity,
    tearSegment = null,
    pinDrift = 0,
  } = options;

  for (const particle of mesh.particles) {
    if (particle.pinned) {
      const driftX = particle.pinX - particle.x;
      const driftY = particle.pinY - particle.y;
      particle.x += driftX * 0.18;
      particle.y += driftY * 0.18;
      particle.oldX = particle.x;
      particle.oldY = particle.y;
      continue;
    }

    const vx = (particle.x - particle.oldX) * damping;
    const vy = (particle.y - particle.oldY) * damping;
    particle.oldX = particle.x;
    particle.oldY = particle.y;
    particle.x += vx;
    particle.y += vy + gravity;

    if (pinDrift > 0) {
      const driftX = (particle.pinX - particle.x) * pinDrift;
      const driftY = (particle.pinY - particle.y) * pinDrift;
      particle.x += driftX;
      particle.y += driftY;
      particle.oldX += driftX * 0.72;
      particle.oldY += driftY * 0.72;
    }
  }

  if (mesh.pointer) {
    applyGrab(mesh, grabStrength);
  }

  let newlyBroken = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const constraint of mesh.constraints) {
      if (constraint.broken) continue;
      const a = mesh.particles[constraint.a];
      const b = mesh.particles[constraint.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;

      if (distance > constraint.rest * tearRatio && canTearConstraint(mesh, constraint, tearCenter, tearRadius, tearSegment)) {
        constraint.broken = true;
        newlyBroken += 1;
        continue;
      }

      const correction = ((distance - constraint.rest) / distance) * constraint.stiffness * 0.5;
      const cx = dx * correction;
      const cy = dy * correction;
      if (!a.pinned) {
        a.x += cx;
        a.y += cy;
      }
      if (!b.pinned) {
        b.x -= cx;
        b.y -= cy;
      }
    }
  }

  if (mesh.pointer) applyGrab(mesh, grabStrength * 0.55);

  mesh.brokenCount += newlyBroken;
  return newlyBroken;
}

function applyGrab(mesh, grabStrength) {
  for (const grab of mesh.grabbed) {
    const particle = mesh.particles[grab.index];
    const targetX = mesh.pointer.x + grab.offsetX * 0.34;
    const targetY = mesh.pointer.y + grab.offsetY * 0.34;
    const pull = grabStrength * (0.35 + grab.weight * 0.65);
    particle.x += (targetX - particle.x) * pull;
    particle.y += (targetY - particle.y) * pull;
  }
}

function canTearConstraint(mesh, constraint, tearCenter, tearRadius, tearSegment) {
  if (!tearCenter && !tearSegment) return false;
  const structuralLimit = Math.max(mesh.width / mesh.columns, mesh.height / mesh.rows) * 1.18;
  if (constraint.rest > structuralLimit) return false;
  const a = mesh.particles[constraint.a];
  const b = mesh.particles[constraint.b];
  const midX = (a.x + b.x) * 0.5;
  const midY = (a.y + b.y) * 0.5;

  if (tearSegment) {
    const length = Math.hypot(tearSegment.to.x - tearSegment.from.x, tearSegment.to.y - tearSegment.from.y);
    if (length > 1) {
      return distanceToSegment({ x: midX, y: midY }, tearSegment.from, tearSegment.to) <= tearRadius;
    }
    return false;
  }

  if (!tearCenter) return false;
  return Math.hypot(midX - tearCenter.x, midY - tearCenter.y) <= tearRadius;
}

function noise2d(x, y, salt) {
  const value = Math.sin(x * 127.1 + y * 311.7 + salt * 53.3) * 43758.5453;
  return (value - Math.floor(value) - 0.5) * 2;
}

export function cellTriangles(mesh, x, y) {
  const stride = mesh.columns + 1;
  const a = y * stride + x;
  const b = y * stride + x + 1;
  const c = (y + 1) * stride + x;
  const d = (y + 1) * stride + x + 1;
  return [[a, c, b], [b, c, d]];
}

export function hasBrokenEdge(mesh, a, b) {
  return mesh.constraints.some((constraint) => (
    constraint.broken
    && ((constraint.a === a && constraint.b === b) || (constraint.a === b && constraint.b === a))
  ));
}
