import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VENDOR = path.join(ROOT, "vendor/MajdataPlay-geometry");
const COMMIT = "850f3e3eac354d328b1e9e8bde50b64c4946faf5";
const REPOSITORY = "https://github.com/TeamMajdata/MajdataPlay";

// Only files used by these three representative examples are vendored. Git blob
// hashes pin each copy to the source tree at COMMIT; SHA-256 is emitted as a
// portable integrity record for downstream fixture consumers.
const INPUTS = [
  ["LICENSE", "f288702d2fa16d3cdf0035b15a9fcbc552cd88e7"],
  ["ProjectSettings/ProjectVersion.txt", "33390a1c1701aac790224774e03aaf05b826ec5e"],
  ["Assets/Scenes/Game.unity", "4b5f13d15322a00d43c719bda892554595191ad7"],
  ["Assets/Scenes/Game.unity.meta", "4664113f3a8b9595fe5c3c0c7c43a77d7bc99fd9"],
  ["Assets/Scripts/Scenes/Game/NoteLoader.cs", "5becfd2901f99d68723de4699bf1cb3553e3db2b"],
  ["Assets/Scripts/Scenes/Game/NoteLoader.cs.meta", "47f20f3739f77394beb88688389a17423883934e"],
  ["Assets/Scripts/Scenes/Game/NoteBehaviours/SlideDrop.cs", "51774cd3effc62483f07c67c94929dcda59592ca"],
  ["Assets/Scripts/Scenes/Game/NoteBehaviours/WifiDrop.cs", "3ad4de0078437c3d3f061c1b4cb7a69771b61403"],
  ["Assets/Scripts/Scenes/Game/NoteBehaviours/SingleSlideBase.cs", "8445f68b32f5f251a27d6a9203b38c5b6d0f8f28"],
  ["Assets/Scripts/Scenes/Game/NoteBehaviours/SlideOK.cs.meta", "bcb99f936b7f20cefb4d60eda5dd9c96f9f512e1"],
  ["Assets/Scripts/Scenes/Game/Utils/NoteHelper.cs", "7fcd6a34c755ad3db8b7294687655844ef44711b"],
  ["Assets/Scripts/IO/Base/Enums/SensorArea.cs", "e7bf4242d68d87380a0deb8bbd69afc80411c760"],
  ["Assets/Scripts/IO/Base/Extensions/SensorAreaExtensions.cs", "51cab02e85a93aa491e3a1952d2b0e2ba9886025"],
  ["Assets/Prefabs/Game/Just_str.prefab", "54f6b50388d85d4882b102aeff56a0c3e06bb685"],
  ["Assets/Prefabs/Game/Just_str.prefab.meta", "cdee8b27cb1bb529be510ac525bc11eed4e69cc1"],
  ["Assets/Prefabs/Game/Slides/Star_Line_3.prefab", "d88272d7c87dfe8219c4e87e38703797cee17a15"],
  ["Assets/Prefabs/Game/Slides/Star_Line_3.prefab.meta", "6bec613ff97e5cbf4549ba1ae808a5ba7b05b79a"],
  ["Assets/Prefabs/Game/Slides/Star_Circle_3.prefab", "39ff38ccfe0462a8e2971d87fa915865b64f9bd6"],
  ["Assets/Prefabs/Game/Slides/Star_Circle_3.prefab.meta", "f9c06653c7876fe5e5d25aaf2f5245428f91c375"],
  ["Assets/Prefabs/Game/Slides/Slide_Wifi.prefab", "f1fd15f08ff5f384e7c8c40ded7690030f4b02eb"],
  ["Assets/Prefabs/Game/Slides/Slide_Wifi.prefab.meta", "b8de49fc9fab97334d540ec19f2d06f3ac0c5352"],
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlobSha1 = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const expectMatch = (match, description) => {
  if (!match) throw new Error(`Unsupported Unity serialization: ${description}`);
  return match;
};

function parseInlineVector(value, keys) {
  const fields = Object.fromEntries(
    value.split(",").map((field) => {
      const match = expectMatch(field.trim().match(/^([xyzw]):\s*([-+\d.eE]+)$/), `vector field ${field}`);
      return [match[1], Number(match[2])];
    }),
  );
  const result = keys.map((key) => fields[key]);
  if (result.some((number) => !Number.isFinite(number))) throw new Error("Non-finite transform component");
  return result;
}

function parseUnityObjects(text, assetPath) {
  const gameObjects = new Map();
  const transforms = new Map();
  const scriptGuids = new Map();
  const prefabInstances = new Map();
  const strippedTransforms = [];
  const documents = text.split(/(?=^--- !u!)/m).filter(Boolean);

  for (const document of documents) {
    const header = document.match(/^--- !u!(\d+) &(-?\d+)/);
    if (!header) continue;
    const classId = Number(header[1]);
    const fileId = header[2];
    if (classId === 1) {
      const name = document.match(/^  m_Name: (.*)$/m)?.[1];
      const componentBlock = document.match(/^  m_Component:\s*\n((?:  - component: \{fileID: -?\d+\}\s*\n)*)/m)?.[1] ?? "";
      const components = [...componentBlock.matchAll(/^  - component: \{fileID: (-?\d+)\}/gm)].map((match) => match[1]);
      if (name !== undefined) gameObjects.set(fileId, { name, components });
    } else if (classId === 4) {
      const sourceObject = document.match(/^  m_CorrespondingSourceObject: \{fileID: (-?\d+), guid: ([0-9a-f]+), type: \d+\}$/m);
      const prefabInstanceId = document.match(/^  m_PrefabInstance: \{fileID: (-?\d+)\}$/m)?.[1];
      const gameObjectId = document.match(/^  m_GameObject: \{fileID: (-?\d+)\}$/m)?.[1];
      if (!gameObjectId && /^--- !u!\d+ &-?\d+\s+stripped\s*$/m.test(document)) {
        if (!sourceObject || !prefabInstanceId) throw new Error(`${assetPath}: incomplete stripped Transform reference`);
        strippedTransforms.push({ fileId, sourceTransformId: sourceObject[1], sourcePrefabGuid: sourceObject[2], prefabInstanceId });
        continue;
      }
      if (!gameObjectId) throw new Error(`${assetPath}: Transform has no GameObject reference`);
      const positionText = expectMatch(document.match(/^  m_LocalPosition: \{([^}]+)\}$/m), `${assetPath} local position`)[1];
      const rotationText = expectMatch(document.match(/^  m_LocalRotation: \{([^}]+)\}$/m), `${assetPath} local rotation`)[1];
      const scaleText = expectMatch(document.match(/^  m_LocalScale: \{([^}]+)\}$/m), `${assetPath} local scale`)[1];
      const childrenBlock = document.match(/^  m_Children:\s*\n((?:  - \{fileID: -?\d+\}\s*\n)*)/m)?.[1] ?? "";
      const children = [...childrenBlock.matchAll(/^  - \{fileID: (-?\d+)\}/gm)].map((match) => match[1]);
      const fatherId = expectMatch(document.match(/^  m_Father: \{fileID: (-?\d+)\}$/m), `${assetPath} Transform.m_Father`)[1];
      transforms.set(fileId, {
        fileId,
        gameObjectId,
        fatherId,
        children,
        position: parseInlineVector(positionText, ["x", "y", "z"]),
        rotation: parseInlineVector(rotationText, ["x", "y", "z", "w"]),
        scale: parseInlineVector(scaleText, ["x", "y", "z"]),
      });
    } else if (classId === 114) {
      const scriptGuid = document.match(/^  m_Script: \{fileID: \d+, guid: ([0-9a-f]+), type: \d+\}$/m)?.[1];
      if (scriptGuid) scriptGuids.set(fileId, scriptGuid);
    } else if (classId === 1001) {
      const sourcePrefabGuid = expectMatch(document.match(/^  m_SourcePrefab: \{fileID: \d+, guid: ([0-9a-f]+), type: \d+\}$/m), `${assetPath} nested Prefab source`)[1];
      const parentTransformId = expectMatch(document.match(/^    m_TransformParent: \{fileID: (-?\d+)\}$/m), `${assetPath} nested Prefab parent`)[1];
      const modificationMatches = [...document.matchAll(/^    - target: \{fileID: (-?\d+), guid: ([0-9a-f]+), type: \d+\}\s*\n      propertyPath: ([^\n]+)\s*\n      value: ([^\n]*)\s*\n      objectReference: ([^\n]*)/gm)];
      const modifications = new Map();
      for (const [, targetId, targetGuid, propertyPath, value, objectReference] of modificationMatches) {
        if (!modifications.has(targetId)) modifications.set(targetId, {});
        modifications.get(targetId)[propertyPath] = { targetGuid, value: value.trim(), objectReference: objectReference.trim() };
      }
      prefabInstances.set(fileId, { fileId, sourcePrefabGuid, parentTransformId, modifications });
    }
  }

  for (const transform of transforms.values()) transform.name = gameObjects.get(transform.gameObjectId)?.name;
  const roots = [...transforms.values()].filter((transform) => transform.fatherId === "0");
  return { assetPath, gameObjects, transforms, scriptGuids, prefabInstances, strippedTransforms, root: roots.length === 1 ? roots[0] : null };
}

function applyVectorOverrides(vector, prefix, overrides) {
  const result = [...vector];
  for (const [index, component] of ["x", "y", "z"].entries()) {
    const value = overrides[`${prefix}.${component}`]?.value;
    if (value !== undefined && value !== "") result[index] = Number(value);
  }
  return result;
}

function parseUnityPrefab(text, assetPath, context) {
  const parsed = parseUnityObjects(text, assetPath);
  const { gameObjects, transforms, scriptGuids, prefabInstances, strippedTransforms } = parsed;
  const nestedReferences = [];

  for (const stripped of strippedTransforms) {
    const instance = prefabInstances.get(stripped.prefabInstanceId);
    if (!instance || instance.sourcePrefabGuid !== stripped.sourcePrefabGuid) {
      throw new Error(`${assetPath}: stripped Transform does not match its PrefabInstance source`);
    }
    const nestedPath = context.prefabPathByGuid.get(stripped.sourcePrefabGuid);
    if (!nestedPath) throw new Error(`${assetPath}: unvendored nested Prefab GUID ${stripped.sourcePrefabGuid}`);
    const nested = parseUnityObjects(context.textOf(nestedPath), nestedPath);
    const nestedRoot = nested.transforms.get(stripped.sourceTransformId);
    if (!nestedRoot || nestedRoot.fatherId !== "0") {
      throw new Error(`${assetPath}: nested Prefab reference is not its root Transform`);
    }
    const overrides = instance.modifications.get(stripped.sourceTransformId) ?? {};
    const nestedObject = nested.gameObjects.get(nestedRoot.gameObjectId);
    const name = overrides.m_Name?.value || nestedRoot.name;
    const isSlideOK = nestedObject?.components.some((componentId) => nested.scriptGuids.get(componentId) === context.slideOkScriptGuid) ?? false;
    if (!isSlideOK) throw new Error(`${assetPath}: nested final child ${nestedPath} has no SlideOK component`);
    const transform = {
      fileId: stripped.fileId,
      gameObjectId: nestedRoot.gameObjectId,
      fatherId: instance.parentTransformId,
      children: [],
      name,
      position: applyVectorOverrides(nestedRoot.position, "m_LocalPosition", overrides),
      rotation: ["x", "y", "z", "w"].map((component, index) => {
        const value = overrides[`m_LocalRotation.${component}`]?.value;
        return value !== undefined && value !== "" ? Number(value) : nestedRoot.rotation[index];
      }),
      scale: applyVectorOverrides(nestedRoot.scale, "m_LocalScale", overrides),
      nestedReference: {
        prefabPath: nestedPath,
        prefabGuid: stripped.sourcePrefabGuid,
        sourceTransformId: stripped.sourceTransformId,
        overrides: Object.fromEntries(Object.entries(overrides).map(([propertyPath, item]) => [propertyPath, item.value])),
        isSlideOK: true,
      },
    };
    transforms.set(transform.fileId, transform);
    nestedReferences.push(transform.nestedReference);
  }

  const roots = [...transforms.values()].filter((transform) => transform.fatherId === "0");
  if (roots.length !== 1) throw new Error(`${assetPath}: expected one prefab root Transform; got ${roots.length}`);
  const root = roots[0];

  const relativePose = (fileId, ancestry = new Set()) => {
    if (fileId === root.fileId) return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    if (ancestry.has(fileId)) throw new Error(`${assetPath}: cyclic Transform hierarchy`);
    const transform = transforms.get(fileId);
    if (!transform) throw new Error(`${assetPath}: missing child Transform ${fileId}`);
    ancestry.add(fileId);
    const parent = transforms.get(transform.fatherId);
    if (!parent) throw new Error(`${assetPath}: Transform ${fileId} is outside the prefab root`);
    const parentPose = relativePose(parent.fileId, ancestry);
    ancestry.delete(fileId);
    const scaled = transform.position.map((component, index) => component * parentPose.scale[index]);
    return {
      position: add(parentPose.position, rotate(parentPose.rotation, scaled)),
      rotation: normalizeQuaternion(multiplyQuaternion(parentPose.rotation, transform.rotation)),
      scale: transform.scale.map((component, index) => component * parentPose.scale[index]),
    };
  };

  const directChildren = root.children.map((fileId) => {
    const transform = transforms.get(fileId);
    if (!transform || transform.fatherId !== root.fileId) {
      throw new Error(`${assetPath}: root m_Children order disagrees with Transform.m_Father`);
    }
    return { transform, pose: relativePose(fileId) };
  });
  if (directChildren.length < 2) throw new Error(`${assetPath}: expected slide strips followed by SlideOK`);
  const terminalChild = directChildren.at(-1).transform;
  const terminalComponents = gameObjects.get(terminalChild.gameObjectId)?.components ?? [];
  const slideOkComponent = terminalComponents.find((componentId) => scriptGuids.get(componentId) === context.slideOkScriptGuid);
  const isSlideOK = terminalChild.nestedReference?.isSlideOK === true || slideOkComponent !== undefined;
  if (!isSlideOK) {
    throw new Error(`${assetPath}: final direct child has no SlideOK component`);
  }

  const visualChildren = directChildren.slice(0, -1);
  const visualStrips = visualChildren.map(({ transform, pose }, index) => ({
    order: index,
    name: transform.name,
    position: roundVector(pose.position),
    rotation: roundVector(pose.rotation),
    scale: roundVector(pose.scale),
  }));
  return {
    rootName: root.name,
    rootTransform: {
      position: roundVector(root.position),
      rotation: roundVector(normalizeQuaternion(root.rotation)),
      scale: roundVector(root.scale),
    },
    rootChildCount: directChildren.length,
    terminalChild: {
      name: terminalChild.name,
      prefabPath: terminalChild.nestedReference?.prefabPath ?? null,
      prefabGuid: terminalChild.nestedReference?.prefabGuid ?? null,
      sourceTransformId: terminalChild.nestedReference?.sourceTransformId ?? null,
      overrides: terminalChild.nestedReference?.overrides ?? {},
      isSlideOK: true,
      slideOkScriptGuid: context.slideOkScriptGuid,
      resolvedPosition: roundVector(directChildren.at(-1).pose.position),
      resolvedRotation: roundVector(directChildren.at(-1).pose.rotation),
      resolvedScale: roundVector(directChildren.at(-1).pose.scale),
    },
    visualStrips,
    nestedReferences,
  };
}

function add(left, right) {
  return left.map((value, index) => value + right[index]);
}

function multiplyQuaternion([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function normalizeQuaternion(quaternion) {
  const norm = Math.hypot(...quaternion);
  return quaternion.map((component) => component / norm);
}

function rotate([x, y, z, w], [vx, vy, vz]) {
  // q * v * q^-1; v is represented by a zero-w quaternion.
  const first = multiplyQuaternion([x, y, z, w], [vx, vy, vz, 0]);
  const result = multiplyQuaternion(first, [-x, -y, -z, w]);
  return result.slice(0, 3);
}

function roundVector(values) {
  return values.map((value) => Number(value.toFixed(6)));
}

function tapPosition(position, radius) {
  const angle = (position * -2 + 5) * 0.125 * Math.PI;
  return roundVector([radius * Math.cos(angle), radius * Math.sin(angle), 0]);
}

function parseGuid(metaText, filePath) {
  return expectMatch(metaText.match(/^guid:\s*([0-9a-f]+)\s*$/m), `${filePath} GUID`)[1];
}

async function main() {
  const sourceBytes = new Map();
  const sources = [];
  for (const [repoPath, expectedGitBlobSha1] of INPUTS) {
    const bytes = await readFile(path.join(VENDOR, repoPath));
    const actualGitBlobSha1 = gitBlobSha1(bytes);
    if (actualGitBlobSha1 !== expectedGitBlobSha1) {
      throw new Error(`${repoPath}: expected Git blob ${expectedGitBlobSha1}, found ${actualGitBlobSha1}`);
    }
    sourceBytes.set(repoPath, bytes);
    sources.push({
      path: repoPath,
      gitBlobSha1: actualGitBlobSha1,
      sha256: sha256(bytes),
    });
  }

  const textOf = (sourcePath) => sourceBytes.get(sourcePath).toString("utf8");
  const prefabPathByGuid = new Map();
  for (const [repoPath] of INPUTS) {
    if (!repoPath.endsWith(".prefab.meta")) continue;
    const prefabPath = repoPath.slice(0, -".meta".length);
    prefabPathByGuid.set(parseGuid(textOf(repoPath), repoPath), prefabPath);
  }
  const slideOkScriptGuid = parseGuid(textOf("Assets/Scripts/Scenes/Game/NoteBehaviours/SlideOK.cs.meta"), "SlideOK.cs.meta");
  const prefabContext = { textOf, prefabPathByGuid, slideOkScriptGuid };
  const scene = textOf("Assets/Scenes/Game.unity");
  const noteLoaderScriptGuid = parseGuid(textOf("Assets/Scripts/Scenes/Game/NoteLoader.cs.meta"), "NoteLoader.cs.meta");
  const noteLoaderBlock = scene
    .split(/(?=^--- !u!)/m)
    .find((document) => document.includes(`guid: ${noteLoaderScriptGuid}, type: 3`));
  const slidePrefabBlock = expectMatch(
    noteLoaderBlock?.match(/^  slidePrefab:\s*\n((?:  - \{fileID: [^\n]+\}\s*\n)+)/m),
    "Game.unity NoteLoader.slidePrefab array",
  )[1];
  const prefabGuids = [...slidePrefabBlock.matchAll(/^  - \{fileID: [^,]+, guid: ([0-9a-f]+), type: 3\}$/gm)].map((match) => match[1]);

  const prefabSpecs = [
    {
      key: "line3",
      prefab: "Assets/Prefabs/Game/Slides/Star_Line_3.prefab",
      meta: "Assets/Prefabs/Game/Slides/Star_Line_3.prefab.meta",
      slidePrefabIndex: 0,
      startPosition: 1,
      endPosition: 3,
    },
    {
      key: "circle3",
      prefab: "Assets/Prefabs/Game/Slides/Star_Circle_3.prefab",
      meta: "Assets/Prefabs/Game/Slides/Star_Circle_3.prefab.meta",
      slidePrefabIndex: 7,
      startPosition: 1,
      endPosition: 4,
    },
  ];

  const slides = prefabSpecs.map((spec) => {
    const guid = parseGuid(textOf(spec.meta), spec.meta);
    if (prefabGuids[spec.slidePrefabIndex] !== guid) {
      throw new Error(`${spec.key}: scene slidePrefab[${spec.slidePrefabIndex}] does not reference ${spec.prefab}`);
    }
    const prefab = parseUnityPrefab(textOf(spec.prefab), spec.prefab, prefabContext);
    const start = tapPosition(spec.startPosition, 4.8);
    const end = tapPosition(spec.endPosition, 4.8);
    return {
      id: spec.key,
      sourcePrefab: spec.prefab,
      sourceMeta: spec.meta,
      sceneReference: { component: "NoteLoader.slidePrefab", index: spec.slidePrefabIndex, guid },
      terminalSlideOK: prefab.terminalChild,
      geometry: {
        coordinateSpace: "Unity XY, units relative to prefab root; +Y up",
        authoredPrefabRootTransform: prefab.rootTransform,
        runtimeRootRotation: "-45 degrees * (startPosition - 1)",
        runtimeRootRotationDegAtSampleStart: 0,
      },
      visualStrips: prefab.visualStrips,
      motionPath: {
        pointMeaning: "SlideDrop.LoadSlidePath StarPositions: ring start, each strip Transform.position, ring end",
        sampleStartPosition: spec.startPosition,
        sampleEndPosition: spec.endPosition,
        ringRadius: 4.8,
        points: [start, ...prefab.visualStrips.map((strip) => strip.position), end],
        temporalInterpolation: "not asserted by this geometry export",
      },
      durationWeights: {
        connectionGroupWeight: prefab.rootChildCount,
        basis: "prefab root Transform.childCount, including terminal SlideOK child",
        applicableWhen: "NoteLoader.CreateSlideGroup connection Slide total-time allocation",
      },
      counts: {
        prefabRootDirectChildren: prefab.rootChildCount,
        visualStrips: prefab.visualStrips.length,
        motionPathPoints: prefab.visualStrips.length + 2,
        connectionWeight: prefab.rootChildCount,
      },
    };
  });

  const wifiSpec = {
    prefab: "Assets/Prefabs/Game/Slides/Slide_Wifi.prefab",
    meta: "Assets/Prefabs/Game/Slides/Slide_Wifi.prefab.meta",
    slidePrefabIndex: 36,
    sourceNotation: "1w5",
    startPosition: 1,
    centerEndPosition: 5,
    classicMode: false,
  };
  const wifiGuid = parseGuid(textOf(wifiSpec.meta), wifiSpec.meta);
  if (prefabGuids[wifiSpec.slidePrefabIndex] !== wifiGuid) {
    throw new Error(`wifi: scene slidePrefab[${wifiSpec.slidePrefabIndex}] does not reference ${wifiSpec.prefab}`);
  }
  const wifiPrefab = parseUnityPrefab(textOf(wifiSpec.prefab), wifiSpec.prefab, prefabContext);
  const startTracks = wifiSpec.classicMode
    ? [
        tapPosition(wifiSpec.startPosition + 0.11, 4.55),
        tapPosition(wifiSpec.startPosition, 4.8),
        tapPosition(wifiSpec.startPosition - 0.13, 4.55),
      ]
    : Array.from({ length: 3 }, () => tapPosition(wifiSpec.startPosition, 4.8));
  const endPositions = [
    ((wifiSpec.centerEndPosition + 6) % 8) + 1,
    wifiSpec.centerEndPosition,
    (wifiSpec.centerEndPosition % 8) + 1,
  ];
  const wifi = {
    id: "wifi",
    sourcePrefab: wifiSpec.prefab,
    sourceMeta: wifiSpec.meta,
    sceneReference: { component: "NoteLoader.slidePrefab", index: wifiSpec.slidePrefabIndex, guid: wifiGuid },
    terminalSlideOK: wifiPrefab.terminalChild,
    sample: {
      notation: wifiSpec.sourceNotation,
      startPosition: wifiSpec.startPosition,
      centerEndPosition: wifiSpec.centerEndPosition,
      classicMode: wifiSpec.classicMode,
    },
    geometry: {
      coordinateSpace: "Unity XY, units relative to prefab root; +Y up",
      authoredPrefabRootTransform: wifiPrefab.rootTransform,
      runtimeRootRotation: "-45 degrees * (startPosition - 1)",
      runtimeRootRotationDegAtSampleStart: 0,
    },
    visualStrips: wifiPrefab.visualStrips,
    motionPaths: ["right", "center", "left"].map((lane, index) => ({
      lane,
      start: startTracks[index],
      end: tapPosition(endPositions[index], 4.8),
      endPosition: endPositions[index],
      interpolation: "Vector3.Lerp(start, end, process)",
    })),
    durationWeights: {
      connectionGroupWeight: null,
      basis: null,
      applicableWhen: "not applicable: NoteLoader rejects Wi-Fi inside a connection Slide",
    },
    counts: {
      prefabRootDirectChildren: wifiPrefab.rootChildCount,
      visualStrips: wifiPrefab.visualStrips.length,
      motionPathTracks: 3,
      connectionWeight: null,
    },
  };

  const generatorBytes = await readFile(fileURLToPath(import.meta.url));
  const output = {
    formatVersion: 1,
    evidence: {
      status: "source-and-prefab-extraction-only",
      playerBehaviorConfirmed: false,
      reason: "No executable build corresponding to this source commit was available for runtime comparison.",
    },
    source: {
      repository: REPOSITORY,
      commit: COMMIT,
      license: "See vendor/MajdataPlay-geometry/LICENSE",
      unityEditorVersion: textOf("ProjectSettings/ProjectVersion.txt").match(/^m_EditorVersion:\s*(.+)$/m)?.[1],
      files: sources,
    },
    generator: {
      path: "tools/geometry-export/extract.mjs",
      sha256: sha256(generatorBytes),
      command: "node tools/geometry-export/extract.mjs",
    },
    slides,
    wifi,
  };
  const outputPath = path.join(ROOT, "fixtures/geometry/majdataplay-850f3e3e-representative.json");
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${path.relative(ROOT, outputPath)}\n`);
}

await main();
