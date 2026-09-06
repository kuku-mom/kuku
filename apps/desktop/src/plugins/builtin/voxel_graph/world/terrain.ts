/** Warm limestone quay over a gently animated, sunlit turquoise sea. */
import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  Quaternion,
  Euler,
} from "three";
import type { IslandSpec } from "../voxel_layout";
import type { WorldPalette } from "./palette";
import { HarborGeometry } from "./harbor_geometry";
import { harborBounds } from "./harbor_bounds";
import { CurvedSurface } from "./curved_surface";
export interface TerrainHandle {
  group: Group;
  update(nowSeconds: number): void;
  dispose(): void;
}
export const WATER_LEVEL = -8;
export function createTerrain(
  islands: readonly IslandSpec[],
  palette: WorldPalette,
  radius: number,
  surface = new CurvedSurface(radius),
): TerrainHandle {
  const group = new Group(),
    kit = new HarborGeometry(surface);
  const b = harborBounds(islands),
    w = b.maxX - b.minX,
    d = b.maxZ - b.minZ,
    cx = (b.minX + b.maxX) / 2,
    cz = (b.minZ + b.maxZ) / 2;

  // Pavers and masonry are instances, with a capped tile count for large vaults.
  const { nx, nz, cutX, cutZ } = b;
  const tw = w / nx,
    td = d / nz;
  const slabs: BoxGeometry[] = [];
  const slabMaterial = new MeshStandardMaterial({ color: "#9e9687", roughness: 0.9 });
  for (const [width, depth] of [
    [w - cutX * 2, d],
    [w, d - cutZ * 2],
  ]) {
    const geometry = new BoxGeometry(
      width,
      9,
      depth,
      Math.min(96, Math.ceil(width / 10)),
      1,
      Math.min(96, Math.ceil(depth / 10)),
    );
    geometry.translate(cx, -5.5, cz);
    surface.bendGeometry(geometry);
    const slab = new Mesh(geometry, slabMaterial);
    slab.name = "curved-quay-foundation";
    slab.castShadow = true;
    slab.receiveShadow = true;
    slabs.push(geometry);
    group.add(slab);
  }
  const tones = ["#cbbb9f", "#cebea3", "#c5b599", "#d3c3a8", "#c9b99e"];
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++)
      if (!((x < 2 || x >= nx - 2) && (z < 2 || z >= nz - 2)))
        kit.add(
          "box",
          tones[(x * 7 + z * 3) % tones.length],
          b.minX + (x + 0.5) * tw,
          -0.35,
          b.minZ + (z + 0.5) * td,
          tw - 0.13,
          0.7,
          td - 0.13,
        );
  function edge(ax: number, az: number, bx: number, bz: number) {
    const len = Math.hypot(bx - ax, bz - az),
      n = Math.ceil(len / 8),
      angle = Math.atan2(bx - ax, bz - az);
    for (let row = 0; row < 3; row++)
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n;
        kit.box(
          ["#9c9488", "#a79e8e", "#b0a594"][(j + row) % 3],
          ax + (bx - ax) * t,
          -1.6 - row * 3,
          az + (bz - az) * t,
          1.1,
          2.85,
          len / n - 0.16,
          angle,
        );
      }
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      kit.box(
        "#d1c1a6",
        ax + (bx - ax) * t,
        0.25,
        az + (bz - az) * t,
        2.6,
        0.7,
        len / n - 0.12,
        angle,
      );
    }
    const posts = Math.floor(len / 9);
    for (let j = 0; j <= posts; j++) {
      const t = j / posts,
        x = ax + (bx - ax) * t,
        z = az + (bz - az) * t;
      // Leave the front two dock gates open.
      if (az === b.maxZ && (Math.abs(x - cx - w * 0.23) < 7 || Math.abs(x - cx + w * 0.29) < 7))
        continue;
      kit.add("pot", "#324d50", x, 2.4, z, 0.55, 4.5, 0.55);
      kit.add("sphere", "#bb9f6d", x, 4.8, z, 0.95, 0.7, 0.95);
      if (j < posts)
        kit.box(
          "#324d50",
          x + (bx - ax) / posts / 2,
          3.9,
          z + (bz - az) / posts / 2,
          0.35,
          0.35,
          len / posts,
          angle,
        );
    }
  }
  const outline = [
    [b.minX + cutX, b.minZ],
    [b.maxX - cutX, b.minZ],
    [b.maxX - cutX, b.minZ + cutZ],
    [b.maxX, b.minZ + cutZ],
    [b.maxX, b.maxZ - cutZ],
    [b.maxX - cutX, b.maxZ - cutZ],
    [b.maxX - cutX, b.maxZ],
    [b.minX + cutX, b.maxZ],
    [b.minX + cutX, b.maxZ - cutZ],
    [b.minX, b.maxZ - cutZ],
    [b.minX, b.minZ + cutZ],
    [b.minX + cutX, b.minZ + cutZ],
  ];
  outline.forEach((p, i) => {
    const next = outline[(i + 1) % outline.length];
    edge(p[0], p[1], next[0], next[1]);
  });

  for (const x of [cx - w * 0.29, cx + w * 0.23]) {
    // The stair and pier extend down to the water without changing agent ground.
    for (let i = 0; i < 5; i++)
      kit.box("#c5b59a", x, -0.4 - i * 0.8, b.maxZ + 1 + i * 1.8, 11, 0.8, 2);
    for (let i = 0; i < 13; i++)
      kit.box(i % 3 ? "#996b42" : "#ae7e50", x, -4.4, b.maxZ + 10 + i * 1.35, 10, 0.7, 1.2);
    for (const side of [-1, 1])
      for (const z of [b.maxZ + 10, b.maxZ + 25]) {
        kit.add("pot", "#665039", x + side * 4.9, -7, z, 1.2, 10, 1.2);
        kit.box("#c5ab7b", x + side * 4.9, -1.8, z, 1.6, 0.5, 1.6);
      }
  }
  // Stone footbridges over the recessed corners, with open masonry arches.
  for (const x of [b.minX + cutX * 0.52, b.maxX - cutX * 0.52]) {
    const az = b.maxZ - cutZ,
      span = cutZ,
      mid = az + span / 2,
      r = span / 2;
    kit.box("#c9b89a", x, -0.65, mid, 7, 1.3, span + 3);
    for (const z of [az, az + span]) kit.box("#a99b85", x, -4.5, z, 8, 9, 3);
    for (let i = 0; i < 11; i++) {
      const a = ((i + 0.5) / 11) * Math.PI;
      kit.add(
        "box",
        i % 2 ? "#b2a18a" : "#bead91",
        x,
        -7 + Math.sin(a) * (r - 1),
        mid + Math.cos(a) * (r - 1),
        7,
        2.1,
        2.3,
        a - Math.PI / 2,
      );
    }
    for (const side of [-1, 1])
      for (let i = 0; i < 6; i++) {
        const z = az + (i * span) / 5;
        kit.add("pot", "#344f52", x + side * 3.3, 1.8, z, 0.35, 3.6, 0.35);
        if (i < 5) kit.box("#344f52", x + side * 3.3, 3.6, z + span / 10, 0.3, 0.3, span / 5);
      }
  }
  group.add(kit.finish());
  const seaMargin = Math.max(75, radius * 0.38) + 12;
  const seaGeometry = new PlaneGeometry(w + seaMargin * 2, d + seaMargin * 2, 64, 64);
  seaGeometry.rotateX(-Math.PI / 2);
  seaGeometry.translate(cx, WATER_LEVEL, cz);
  surface.bendGeometry(seaGeometry);
  const seaMaterial = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      time: { value: 0 },
      globeRadius: { value: surface.radius },
      haze: { value: new Color(palette.fog) },
      hazeRange: { value: new Vector2(Math.max(20, radius * 0.1), Math.max(75, radius * 0.38)) },
      quayCenter: { value: new Vector2(cx, cz) },
      quayHalf: { value: new Vector2(w / 2, d / 2) },
      quayCut: { value: new Vector2(cutX, cutZ) },
      shallow: { value: new Color(palette.waterShallow) },
      deep: { value: new Color(palette.waterDeep) },
      foamColor: { value: new Color(palette.foam) },
    },
    vertexShader: `varying vec3 world; void main(){world=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(world,1.);}`,
    fragmentShader: `
    varying vec3 world; uniform float time; uniform float globeRadius; uniform vec3 haze; uniform vec2 hazeRange; uniform vec3 foamColor; uniform vec3 shallow; uniform vec3 deep; uniform vec2 quayCenter;uniform vec2 quayHalf;uniform vec2 quayCut;
    float boxDistance(vec2 p,vec2 b){vec2 q=abs(p)-b;return length(max(q,0.))+min(max(q.x,q.y),0.);}
    float wave(vec2 p){return sin(p.x*.14+sin(p.y*.09+time*.3)*2.+time*.38)*sin(p.y*.17-time*.23);}
    void main(){vec3 radial=world+vec3(0.,globeRadius,0.);float horizontal=length(radial.xz);float angle=atan(horizontal,radial.y);vec2 p=radial.xz*(globeRadius*angle/max(horizontal,.0001));float n=wave(p)+wave(p*.47)*.6;float light=pow(max(0.,wave(p*1.8)),16.);vec3 c=mix(deep,shallow,.56+n*.16)+vec3(.22,.3,.28)*light*.25;float shore=min(boxDistance(p-quayCenter,quayHalf-vec2(quayCut.x,0.)),boxDistance(p-quayCenter,quayHalf-vec2(0.,quayCut.y)));float foam=pow(max(0.,sin(shore*1.7+n*1.4-time*.65)),6.)*exp(-abs(shore)*.34);c=mix(c,foamColor,foam*.35);vec3 normal=normalize(radial);float sun=max(0.,dot(normal,normalize(vec3(-.4,1.,.6))));c*=.75+sun*.3;float rim=pow(1.-max(0.,dot(normal,normalize(cameraPosition-world))),4.);c=mix(c,haze,rim*.48);float opacity=1.-smoothstep(hazeRange.x,hazeRange.y,max(0.,shore));if(opacity<.005)discard;gl_FragColor=vec4(c,opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    }`,
  });
  const sea = new Mesh(seaGeometry, seaMaterial);
  sea.name = "spherical-ocean";
  group.add(sea);
  // A little mail boat, composed from curved hull sections and timber decking.
  const boatKit = new HarborGeometry();
  boatKit.add("hull", "#ac4f3d", 0, 0, 0, 11, 3.6, 23);
  boatKit.add("hull", "#eee0bb", 0, 1.2, 0, 11.3, 0.75, 22.4);
  boatKit.add("hull", "#a65b42", 0, 2, 0, 10.8, 0.9, 21);
  boatKit.add("hull", "#bc976a", 0, 2.55, 0, 9.2, 0.5, 18);
  boatKit.add("soft", "#e9ddbe", 0, 5, 1, 7, 5.3, 8);
  boatKit.box("#ece0bf", 0, 8, 1, 8.4, 0.7, 9.5);
  for (const side of [-1, 1]) boatKit.box("#31555f", side * 3.55, 5.8, 1, 0.15, 2.4, 3.4);
  boatKit.box("#31555f", 0, 5.8, 5.1, 4, 2.4, 0.15);
  boatKit.box("#835f3e", 0, 12, 1, 0.35, 8, 0.35);
  boatKit.box("#f1e4be", 1.8, 14.5, 1, 3.4, 2.2, 0.15);
  for (const x of [-2.5, 2.5]) boatKit.box("#ac7d48", x, 3.8, -6, 3, 2.8, 3.5);
  const boat = boatKit.finish();
  const boatChart = new Vector3(cx - w * 0.08, WATER_LEVEL + 1, b.maxZ + 43);
  const boatTilt = surface.orientationAt(boatChart),
    boatTurn = new Quaternion(),
    boatEuler = new Euler();
  function placeBoat(t: number) {
    boatChart.y = WATER_LEVEL + 1 + Math.sin(t * 0.9) * 0.3;
    surface.project(boatChart, boat.position);
    boatTurn.setFromEuler(boatEuler.set(0, 1.2, Math.sin(t * 0.7) * 0.025));
    boat.quaternion.copy(boatTilt).multiply(boatTurn);
  }
  placeBoat(0);
  group.add(boat);
  return {
    group,
    update: (t) => {
      seaMaterial.uniforms.time.value = t;
      placeBoat(t);
    },
    dispose: () => {
      kit.dispose();
      slabs.forEach((geometry) => geometry.dispose());
      slabMaterial.dispose();
      boatKit.dispose();
      seaGeometry.dispose();
      seaMaterial.dispose();
    },
  };
}
