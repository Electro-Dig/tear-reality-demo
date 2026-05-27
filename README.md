# Tear Reality Demo

一个浏览器里的“撕开画面”交互原型。它把多层画面叠在一起，用户通过鼠标拖拽或 MediaPipe 手势捏合来拉扯表面；表面会像布料/纸张一样发生连续形变，并在局部应力足够大时撕裂，露出下一层内容。

这个项目的目标不是复刻完整商业作品，而是保留核心机制：拉扯、断裂、缺口持久化、多层纵深、手势输入。

## Demo 能力

- Canvas + WebGL 渲染多层可撕裂画面。
- 基于粒子和约束的简化布料网格。
- 鼠标拖拽撕裂。
- MediaPipe Hands 手势捏合撕裂。
- 支持上传图片，自动填充为三层可撕裂画面。
- 支持多种撕裂模式：
  - `Tear Shards`: 细小几何碎片模式，实时显示局部破裂。
  - `Tear Auto`: 根据拉扯幅度自动选择碎片、小片、大块撕裂。
  - `Tear Sheet`: 更偏大片布面撕裂。
  - `Tear Strip`: 更偏条带撕裂。
- 非碎片模式的缺口会提交到持久遮罩，不会在后续拖拽中被补回去。
- UI 可以隐藏，保留更沉浸的画面体验。

## 快速开始

```bash
npm install
npm run serve
```

默认服务地址：

```text
http://localhost:4177/
```

运行测试：

```bash
npm test
```

视觉 smoke 测试：

```bash
node tests/visual-smoke.mjs
```

`visual-smoke.mjs` 依赖 Playwright。当前项目没有把 Playwright 写入 `package.json`，如果你的环境没有全局或工作区提供 Playwright，需要自行安装。

## 项目结构

```text
.
├── index.html
├── styles.css
├── server.js
├── src
│   ├── app.js                 # 应用状态机、输入处理、主绘制循环
│   ├── clothMesh.js           # 布料粒子、约束、拉扯、断裂模拟
│   ├── handAnalysis.js        # 手部关键点到 pinch 状态的分析
│   ├── handTracker.js         # MediaPipe Hands 初始化与帧检测
│   ├── layerAdvance.js        # 判断是否进入下一层
│   ├── layerImages.js         # 上传图片分配到多层
│   ├── meshTopology.js        # WebGL 网格三角面和断裂边判断
│   ├── tearFeedback.js        # 撕裂模式、反馈宽度、手势半径等策略
│   ├── tearGeometry.js        # 撕裂带、开口、多边形几何
│   └── webglClothRenderer.js  # WebGL 纹理网格渲染器
└── tests
    ├── handAnalysis.test.js
    ├── layerAdvance.test.js
    ├── layerImages.test.js
    ├── tearFeedback.test.js
    ├── tearGeometry.test.js
    └── visual-smoke.mjs
```

## 核心实现思路

### 1. 多层画面

`src/app.js` 维护 `state.layers`，每一层都是一张离屏 canvas。默认会生成房间、档案纸、蓝图三层；上传图片后会用真实图片替换这些层。

WebGL 渲染时会先画下一层，再把当前层作为纹理贴到布料网格上。当前层被撕开后，下一层自然露出来。

### 2. 布料网格

`src/clothMesh.js` 创建一个二维粒子网格：

- 每个粒子保存当前位置、上一帧位置、固定点位置和 UV。
- 粒子之间通过结构约束连接。
- 拖拽时，附近粒子被抓住并跟随指针移动。
- 约束被拉伸超过阈值时标记为 broken。

这套模型不追求真实物理，而是服务于交互手感：要能被拉长、回弹、局部断裂。

### 3. 撕裂模式

`src/tearFeedback.js` 负责把输入动作转换为视觉策略：

- 小范围拖拽更像细碎破裂。
- 大幅度拖拽更像大片撕开。
- 手势输入会使用更小的抓取半径，避免一只手把整片画面拉走。
- 双手捏合不再直接撕裂两手之间整条跨度，而是沿两只手各自的运动轨迹产生撕裂压力。

### 4. 缺口持久化

非碎片模式下，释放鼠标或手势后，撕裂路径会被提交到 `committedMaskLayer`。这个持久 mask 会持续参与当前层的遮罩合成。

这样做是为了避免一个常见问题：如果缺口只存在于最近几个 `tearPaths` 中，后续拖拽可能把旧路径挤掉，视觉上就像已经撕开的洞被修复了。

### 5. 手势交互

`src/handTracker.js` 使用 `@mediapipe/tasks-vision` 的 `HandLandmarker`。

当前手势逻辑：

- 单手：拇指和食指捏合后，使用 pinch 中心作为拖拽点。
- 双手：两只手都捏合时，进入 two-hand 模式。
- 手部关键点会显示在画面上，帮助用户理解系统正在识别手。
- 检测目标帧率为 30fps，并保留少量平滑以降低抖动。

浏览器需要允许摄像头权限。`localhost` 可以直接使用摄像头，不需要 HTTPS。

## 关键交互约束

这个项目里有几个刻意保留的规则，修改时最好不要轻易破坏：

- 拖拽过程中优先显示“表面被拉伸”，不要提前显示完整的撕裂碎片轮廓。
- 非碎片模式释放后才提交大块缺口。
- 已提交的缺口必须持久存在，直到 reset 或进入下一层。
- `Tear Shards` 模式可以实时显示破裂，因为它本身就是细小碎片反馈。
- 双手捏合不能把两手之间整条线当作每帧切割线，否则会产生快速拉扯、压缩和大面积误撕裂。

## 开发建议

如果你要继续调手感，优先看这些参数：

- `src/app.js`
  - `HAND_POINT_SMOOTHING`
  - `TWO_HAND_CENTER_SMOOTHING`
  - `meshResolution()`
  - `tearBandRadius()`
  - `minTearSegmentLength()`
- `src/tearFeedback.js`
  - `resolveTearStyle()`
  - `tearWidthForMotion()`
  - `grabRadiusForSource()`
- `src/clothMesh.js`
  - `stressClothMesh()`
  - `stepClothMesh()`
  - `canTearConstraint()`

一般来说，先调整 `tearFeedback.js` 里的策略参数，再动底层布料模拟。底层约束变化会影响所有模式，风险更高。

## 测试策略

项目使用 Node.js 内置测试框架：

```bash
node --test tests/*.test.js
```

测试覆盖重点：

- 手势 pinch 分析。
- 上传图片到多层的分配规则。
- 撕裂模式选择。
- 缺口是否持久化。
- 双手撕裂是否沿手部运动轨迹，而不是沿两手跨度整条线。
- 布料断裂是否限制在当前拖拽段附近。
- 层级推进是否不会被一次长拖拽误触发。

视觉行为还需要浏览器里人工验证，尤其是手势识别、真实图片上传后的撕裂观感。

## 复刻核心效果的提示词

如果你想让其他开发者或 AI 工具快速复刻一个核心版，可以从这段需求开始：

```text
请做一个单页 Web 互动 demo，主题是“撕开画面”。

用户按住并拖拽画面时，画面不要像橡皮擦一样被擦掉，而要像一张有弹性的布或纸被拉扯。拖拽过程中表面需要连续变形、拉长、起伏；当局部拉伸超过阈值时，约束断裂，形成不规则撕裂缺口，露出下一层画面。

技术要求：
1. 使用 HTML/CSS/JavaScript，实现 Canvas 或 WebGL 渲染。
2. 至少有 3 层画面叠加，当前层撕开后能看到下一层。
3. 使用简化布料网格或粒子约束系统：粒子有原始位置、当前位置、上一帧位置；粒子之间有约束；拖拽时抓住附近粒子；约束拉伸超过阈值后断裂。
4. 拖拽中主要显示“表面被拉伸”的反馈，不要提前显示完整的撕裂碎片轮廓。
5. 释放后把非碎片模式的缺口提交到持久 mask，后续拖拽不能把旧缺口修复。
6. 撕裂边缘要不规则、有毛边，不要出现规则六边形、菱形或大块几何拼贴。
7. 提供 Reset 按钮。

重点是交互手感：拖动时要有连续、平滑、被拉扯的张力；撕裂后要有纵深感。
```

## License

当前仓库未声明开源协议。公开分享或复用前，请先补充明确的 license。
