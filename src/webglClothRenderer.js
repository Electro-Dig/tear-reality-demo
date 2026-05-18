import { renderCellTriangles, triangleIsTorn } from './meshTopology.js';

export class WebglClothRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('WebGL is not available');

    this.program = createProgram(this.gl, vertexShaderSource, fragmentShaderSource);
    this.positionLocation = this.gl.getAttribLocation(this.program, 'a_position');
    this.uvLocation = this.gl.getAttribLocation(this.program, 'a_uv');
    this.resolutionLocation = this.gl.getUniformLocation(this.program, 'u_resolution');
    this.textureLocation = this.gl.getUniformLocation(this.program, 'u_texture');
    this.vertexBuffer = this.gl.createBuffer();
    this.indexBuffer = this.gl.createBuffer();
    this.textureCache = new WeakMap();
    this.quadVertices = new Float32Array(16);
    this.quadIndices = new Uint16Array([0, 1, 2, 2, 1, 3]);
    this.vertexArray = new Float32Array(0);
    this.indexArray = new Uint16Array(0);

    const gl = this.gl;
    gl.useProgram(this.program);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.enableVertexAttribArray(this.uvLocation);
    gl.uniform1i(this.textureLocation, 0);
  }

  resize(width, height) {
    this.canvas.width = Math.round(width);
    this.canvas.height = Math.round(height);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  render({ nextLayer, currentLayer, mesh, brokenEdges, ignoreBroken = false }) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.05, 0.045, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    gl.uniform2f(this.resolutionLocation, mesh.width, mesh.height);
    gl.disable(gl.BLEND);
    this.drawPlane(nextLayer, mesh.width, mesh.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.drawMesh(currentLayer, mesh, brokenEdges, ignoreBroken);
    gl.disable(gl.BLEND);
  }

  drawPlane(textureSource, width, height) {
    this.quadVertices.set([
      0, 0, 0, 0,
      width, 0, 1, 0,
      0, height, 0, 1,
      width, height, 1, 1,
    ]);
    this.draw(textureSource, this.quadVertices, this.quadIndices, this.quadIndices.length);
  }

  drawMesh(textureSource, mesh, brokenEdges, ignoreBroken) {
    const particleCount = mesh.particles.length;
    const vertexLength = particleCount * 4;
    if (this.vertexArray.length !== vertexLength) this.vertexArray = new Float32Array(vertexLength);

    for (let index = 0; index < particleCount; index += 1) {
      const particle = mesh.particles[index];
      const offset = index * 4;
      this.vertexArray[offset] = particle.x;
      this.vertexArray[offset + 1] = particle.y;
      this.vertexArray[offset + 2] = particle.u;
      this.vertexArray[offset + 3] = particle.v;
    }

    const maxIndices = mesh.columns * mesh.rows * 6;
    if (this.indexArray.length !== maxIndices) this.indexArray = new Uint16Array(maxIndices);

    let cursor = 0;
    for (let y = 0; y < mesh.rows; y += 1) {
      for (let x = 0; x < mesh.columns; x += 1) {
        for (const [a, b, c] of renderCellTriangles(mesh, x, y)) {
          if (!ignoreBroken && triangleIsTorn(a, b, c, brokenEdges)) continue;
          this.indexArray[cursor] = a;
          this.indexArray[cursor + 1] = b;
          this.indexArray[cursor + 2] = c;
          cursor += 3;
        }
      }
    }

    this.draw(textureSource, this.vertexArray, this.indexArray, cursor);
  }

  draw(textureSource, vertices, indices, indexCount) {
    const gl = this.gl;
    const texture = this.getTexture(textureSource);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(this.uvLocation, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices.subarray(0, indexCount), gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
  }

  getTexture(source) {
    let entry = this.textureCache.get(source);
    const gl = this.gl;
    if (!entry) {
      entry = {
        texture: gl.createTexture(),
        width: 0,
        height: 0,
        uploaded: false,
      };
      this.textureCache.set(source, entry);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    if (!entry.uploaded || entry.width !== source.width || entry.height !== source.height) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      entry.width = source.width;
      entry.height = source.height;
      entry.uploaded = true;
    }
    return entry.texture;
  }

  invalidateTexture(source) {
    const entry = this.textureCache.get(source);
    if (entry) entry.uploaded = false;
  }
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(info || 'Shader compile failed');
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(info || 'Program link failed');
  }
  return program;
}

const vertexShaderSource = `
attribute vec2 a_position;
attribute vec2 a_uv;
uniform vec2 u_resolution;
varying vec2 v_uv;

void main() {
  vec2 zeroToOne = a_position / u_resolution;
  vec2 clip = zeroToOne * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
}
`;

const fragmentShaderSource = `
precision mediump float;
uniform sampler2D u_texture;
varying vec2 v_uv;

void main() {
  gl_FragColor = texture2D(u_texture, v_uv);
}
`;
