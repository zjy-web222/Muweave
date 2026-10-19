import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import {
  cameraAt,
  objectAt,
  validateGlb,
  type PrevisScene,
  type PrevisPlan,
  type PrevisObject,
  type Vec3,
} from '../shared/previs'

const radians = THREE.MathUtils.degToRad
function dispose(root: THREE.Object3D) {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh || node instanceof THREE.Line)) return
    node.geometry.dispose()
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      for (const value of Object.values(material))
        if (value instanceof THREE.Texture) value.dispose()
      material.dispose()
    }
  })
}
function box(parent: THREE.Object3D, size: Vec3, position: Vec3, material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.position.set(...position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}
function proxy(object: PrevisObject) {
  const group = new THREE.Group(),
    material = new THREE.MeshStandardMaterial({ color: object.color, roughness: 0.85 })
  const limb = (name: string, position: Vec3, size: Vec3, offset: Vec3) => {
    const joint = new THREE.Group()
    joint.name = name
    joint.position.set(...position)
    group.add(joint)
    box(joint, size, offset, material)
  }
  if (object.kind === 'person') {
    box(group, [0.4, 0.6, 0.24], [0, 1.18, 0], material)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), material)
    head.position.y = 1.68
    head.castShadow = true
    group.add(head)
    box(group, [0.09, 0.07, 0.06], [0, 1.68, 0.18], material)
    limb('leftArm', [-0.29, 1.43, 0], [0.13, 0.56, 0.14], [0, -0.26, 0])
    limb('rightArm', [0.29, 1.43, 0], [0.13, 0.56, 0.14], [0, -0.26, 0])
    limb('leftLeg', [-0.12, 0.88, 0], [0.15, 0.83, 0.18], [0, -0.41, 0])
    limb('rightLeg', [0.12, 0.88, 0], [0.15, 0.83, 0.18], [0, -0.41, 0])
  } else if (object.kind === 'table') {
    box(group, [1.8, 0.12, 0.9], [0, 0.8, 0], material)
    for (const x of [-0.75, 0.75])
      for (const z of [-0.32, 0.32]) box(group, [0.08, 0.8, 0.08], [x, 0.4, z], material)
  } else if (object.kind === 'chair') {
    box(group, [0.5, 0.09, 0.5], [0, 0.48, 0], material)
    box(group, [0.5, 0.5, 0.07], [0, 0.78, -0.23], material)
    for (const x of [-0.2, 0.2])
      for (const z of [-0.2, 0.2]) box(group, [0.06, 0.48, 0.06], [x, 0.24, z], material)
  } else if (object.kind === 'door') {
    box(group, [0.12, 2.3, 0.15], [-0.65, 1.15, 0], material)
    box(group, [0.12, 2.3, 0.15], [0.65, 1.15, 0], material)
    box(group, [1.4, 0.15, 0.15], [0, 2.3, 0], material)
  } else if (object.kind === 'sphere') {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 12), material)
    mesh.position.y = 0.5
    mesh.castShadow = true
    group.add(mesh)
  } else
    box(
      group,
      object.kind === 'wall' ? [6, 3, 0.15] : [1, 1, 1],
      object.kind === 'wall' ? [0, 1.5, 0] : [0, 0.5, 0],
      material,
    )
  return group
}

export class PrevisStage {
  private scene = new THREE.Scene()
  private renderer: THREE.WebGLRenderer
  private editor = new THREE.PerspectiveCamera(45, 1, 0.05, 1000)
  private camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 1000)
  private orbit: OrbitControls
  private transform: TransformControls
  private guides = new THREE.Group()
  private objects = new Map<string, THREE.Group>()
  private data?: PrevisScene
  private plan?: PrevisPlan
  private time = 0
  private selected = ''
  private observer: ResizeObserver
  private destroyed = false
  private generation = 0
  private geometryKey = ''
  private loading?: Promise<void>
  private cameraView = false
  private drawing = false
  private exporting = false
  private width = 1
  private height = 1
  private aspect = 16 / 9
  private ray = new THREE.Raycaster()
  private down = new THREE.Vector2()
  private label = document.createElement('span')
  constructor(
    private host: HTMLDivElement,
    private callbacks: {
      select(id: string): void
      transform(id: string, position: Vec3, yaw: number, scale: Vec3): void
      point(position: Vec3): void
      error(message: string): void
    },
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.setAttribute('aria-label', '3D 预演视窗')
    host.append(this.renderer.domElement)
    this.label.className = 'previs-object-label'
    host.append(this.label)
    this.scene.background = new THREE.Color('#e9ece5')
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x7b8573, 2.4))
    const light = new THREE.DirectionalLight(0xffffff, 2.6)
    light.position.set(5, 12, 6)
    light.castShadow = true
    light.shadow.mapSize.set(1024, 1024)
    light.shadow.camera.left = -12
    light.shadow.camera.right = 12
    light.shadow.camera.top = 12
    light.shadow.camera.bottom = -12
    light.shadow.normalBias = 0.04
    this.scene.add(light)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: '#e1e4dc', roughness: 1 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)
    this.guides.add(new THREE.GridHelper(40, 40, 0xa7b09e, 0xcbd0c5))
    this.guides.add(new THREE.CameraHelper(this.camera))
    this.scene.add(this.guides)
    this.editor.position.set(7, 5, 8)
    this.orbit = new OrbitControls(this.editor, this.renderer.domElement)
    this.orbit.target.set(0, 1, 0)
    this.orbit.maxDistance = 100
    this.orbit.update()
    this.orbit.addEventListener('change', () => this.render())
    this.transform = new TransformControls(this.editor, this.renderer.domElement)
    this.transform.addEventListener('dragging-changed', (event) => {
      this.orbit.enabled = !event.value
    })
    this.transform.addEventListener('change', () => this.render())
    this.transform.addEventListener('mouseUp', () => {
      const object = this.objects.get(this.selected)
      if (object) {
        const position = object.position.toArray() as Vec3,
          data = this.data?.objects.find((item) => item.id === this.selected)
        if (data && this.plan && objectAt(data, this.plan, this.time).pose === 'sit')
          position[1] += 0.38
        this.callbacks.transform(
          this.selected,
          position,
          THREE.MathUtils.radToDeg(object.rotation.y),
          object.scale.toArray() as Vec3,
        )
      }
    })
    this.scene.add(this.transform.getHelper())
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown)
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp)
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    this.resize()
  }
  private contextLost = (event: Event) => {
    event.preventDefault()
    this.callbacks.error('3D 图形上下文丢失，请返回列表后重新打开预演')
  }
  private pointerDown = (event: PointerEvent) => {
    this.down.set(event.clientX, event.clientY)
  }
  private pointerUp = (event: PointerEvent) => {
    if (
      event.button !== 0 ||
      this.exporting ||
      this.transform.dragging ||
      this.down.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5
    )
      return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const width = this.cameraView ? Math.min(rect.width, rect.height * this.aspect) : rect.width
    const height = this.cameraView ? width / this.aspect : rect.height
    const x = event.clientX - rect.left - (rect.width - width) / 2,
      y = event.clientY - rect.top - (rect.height - height) / 2
    if (x < 0 || y < 0 || x > width || y > height) return
    this.ray.setFromCamera(
      new THREE.Vector2((x / width) * 2 - 1, (-y / height) * 2 + 1),
      this.cameraView ? this.camera : this.editor,
    )
    if (this.drawing) {
      const point = new THREE.Vector3()
      if (this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point))
        this.callbacks.point([Number(point.x.toFixed(2)), 0, Number(point.z.toFixed(2))])
      return
    }
    if (this.transform.axis) return
    const hits = this.ray.intersectObjects(
      [...this.objects.values()].filter((object) => object.visible),
      true,
    )
    let node: THREE.Object3D | undefined = hits[0]?.object
    while (node && !node.userData.previsId) node = node.parent || undefined
    this.callbacks.select(node?.userData.previsId || '')
  }
  private resize() {
    if (this.destroyed || this.exporting) return
    this.width = Math.max(1, this.host.clientWidth)
    this.height = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(this.width, this.height)
    this.editor.aspect = this.width / this.height
    this.editor.updateProjectionMatrix()
    this.render()
  }
  setScene(data: PrevisScene, urls: Map<string, string>): Promise<void> {
    this.data = data
    const geometryKey = JSON.stringify(
      data.objects.map((object) => [object.id, object.kind, object.color, object.modelMediaId]),
    )
    if (geometryKey === this.geometryKey)
      return (this.loading || Promise.resolve()).then(() => {
        this.seek(this.time)
        this.select(this.selected)
      })
    this.geometryKey = geometryKey
    this.loading = this.loadScene(data, urls).catch((error: unknown) => {
      this.geometryKey = ''
      throw error
    })
    return this.loading
  }
  private async loadScene(data: PrevisScene, urls: Map<string, string>) {
    const generation = ++this.generation
    this.transform.detach()
    for (const object of this.objects.values()) {
      this.scene.remove(object)
      dispose(object)
    }
    this.objects.clear()
    for (const object of data.objects) {
      const group = proxy(object)
      group.userData.previsId = object.id
      this.objects.set(object.id, group)
      this.scene.add(group)
      if (object.kind === 'model' && object.modelMediaId) {
        try {
          const url = urls.get(object.modelMediaId)
          if (!url) throw new Error('三维模型素材不存在')
          const response = await fetch(url)
          if (!response.ok) throw new Error('无法读取三维模型')
          const bytes = await response.arrayBuffer()
          validateGlb(new Uint8Array(bytes))
          const manager = new THREE.LoadingManager()
          manager.setURLModifier((url) => {
            if (!url.startsWith('blob:')) throw new Error('模型不允许加载外部资源')
            return url
          })
          const model = await new GLTFLoader(manager).parseAsync(bytes, '')
          if (this.destroyed || generation !== this.generation) {
            dispose(model.scene)
            return
          }
          dispose(group)
          group.clear()
          group.add(model.scene)
          model.scene.traverse((mesh) => {
            if (mesh instanceof THREE.Mesh) {
              mesh.castShadow = true
              mesh.receiveShadow = true
            }
          })
        } catch (error) {
          this.callbacks.error(error instanceof Error ? error.message : '模型加载失败')
          throw error
        }
      }
    }
    this.seek(this.time)
    this.select(this.selected)
  }
  setPlan(plan: PrevisPlan, aspect: number) {
    this.plan = plan
    this.aspect = aspect
    this.camera.aspect = aspect
    this.seek(this.time)
  }
  seek(time: number) {
    this.time = time
    if (!this.data || !this.plan || this.exporting) return
    for (const object of this.data.objects) {
      const node = this.objects.get(object.id)
      if (!node) continue
      const state = objectAt(object, this.plan, time)
      node.position.set(...state.position)
      node.rotation.y = radians(state.yaw)
      node.scale.set(...object.scale)
      node.visible = !object.hidden
      if (object.kind === 'person') {
        const stride =
          state.pose === 'run'
            ? Math.sin(state.phase * 11) * 0.8
            : state.pose === 'walk'
              ? Math.sin(state.phase * 7) * 0.5
              : 0
        for (const [name, sign] of [
          ['leftArm', -1],
          ['rightArm', 1],
          ['leftLeg', 1],
          ['rightLeg', -1],
        ] as const) {
          const limb = node.getObjectByName(name)!
          limb.rotation.set(
            state.pose === 'sit' && name.endsWith('Leg') ? -Math.PI / 2 : stride * sign,
            0,
            state.pose === 'wave' && name === 'rightArm'
              ? -2.4 + Math.sin(state.phase * 8) * 0.2
              : 0,
          )
        }
        if (state.pose === 'sit') node.position.y -= 0.38
      }
    }
    const camera = cameraAt(this.plan, time)
    this.camera.position.set(...camera.position)
    this.camera.lookAt(...camera.target)
    this.camera.fov = camera.fov
    this.camera.updateProjectionMatrix()
    const helper = this.guides.children.find((child) => child instanceof THREE.CameraHelper)
    if (helper instanceof THREE.CameraHelper) {
      this.camera.updateMatrixWorld()
      this.camera.far = 2
      this.camera.updateProjectionMatrix()
      helper.update()
      this.camera.far = 1000
      this.camera.updateProjectionMatrix()
    }
    this.render()
  }
  select(id: string) {
    this.selected = id
    this.transform.detach()
    const node = this.objects.get(id),
      data = this.data?.objects.find((object) => object.id === id)
    if (
      node &&
      data &&
      !data.locked &&
      !data.hidden &&
      !this.cameraView &&
      !this.drawing &&
      !this.exporting
    )
      this.transform.attach(node)
    this.label.textContent = data?.name || ''
    this.render()
  }
  mode(mode: 'translate' | 'rotate' | 'scale') {
    this.transform.setMode(mode)
  }
  setSnap(on: boolean) {
    this.transform.setTranslationSnap(on ? 0.25 : null)
    this.transform.setRotationSnap(on ? Math.PI / 12 : null)
  }
  view(view: 'editor' | 'camera' | 'top') {
    this.cameraView = view === 'camera'
    this.orbit.enabled = !this.cameraView
    if (view === 'top') {
      this.editor.position.set(0, 20, 0.01)
      this.orbit.target.set(0, 0, 0)
      this.orbit.update()
    }
    if (view === 'editor') {
      this.editor.position.set(7, 5, 8)
      this.orbit.target.set(0, 1, 0)
      this.orbit.update()
    }
    this.select(this.selected)
  }
  currentCamera() {
    return {
      time: this.time,
      position: this.editor.position.toArray() as Vec3,
      target: this.orbit.target.toArray() as Vec3,
      fov: this.editor.fov,
    }
  }
  draw(on: boolean) {
    this.drawing = on
    this.orbit.enableRotate = !on
    this.select(this.selected)
    this.renderer.domElement.style.cursor = on ? 'crosshair' : ''
  }
  path(points: Vec3[]) {
    for (const child of [...this.guides.children])
      if (child.userData.path) {
        this.guides.remove(child)
        dispose(child)
      }
    if (points.length > 1) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          points.map((point) => new THREE.Vector3(point[0], point[1] + 0.035, point[2])),
        ),
        new THREE.LineBasicMaterial({ color: 0xba793e }),
      )
      line.userData.path = true
      this.guides.add(line)
    }
    this.render()
  }
  private render() {
    if (this.destroyed || this.exporting) return
    this.renderer.setScissorTest(false)
    this.renderer.setViewport(0, 0, this.width, this.height)
    if (this.cameraView) {
      this.renderer.setClearColor('#20241f')
      this.renderer.clear()
      const width = Math.min(this.width, this.height * this.aspect),
        height = width / this.aspect
      const x = (this.width - width) / 2,
        y = (this.height - height) / 2
      this.renderer.setViewport(x, y, width, height)
      this.renderer.setScissor(x, y, width, height)
      this.renderer.setScissorTest(true)
    }
    this.guides.visible = !this.cameraView
    this.renderer.render(this.scene, this.cameraView ? this.camera : this.editor)
    if (!this.cameraView && this.width > 450) {
      const w = Math.min(250, this.width * 0.32),
        h = w / this.aspect
      this.renderer.setScissorTest(true)
      this.renderer.setScissor(this.width - w - 16, this.height - h - 16, w, h)
      this.renderer.setViewport(this.width - w - 16, this.height - h - 16, w, h)
      const helper = this.transform.getHelper(),
        visible = helper.visible
      this.guides.visible = false
      helper.visible = false
      this.renderer.render(this.scene, this.camera)
      helper.visible = visible
      this.guides.visible = true
      this.renderer.setScissorTest(false)
    }
    const object = this.objects.get(this.selected)
    this.label.hidden = !object || !object.visible || this.cameraView
    if (object) {
      const position = object.position
        .clone()
        .add(new THREE.Vector3(0, 2, 0))
        .project(this.editor)
      this.label.style.left = `${((position.x + 1) * this.width) / 2}px`
      this.label.style.top = `${((1 - position.y) * this.height) / 2}px`
    }
  }
  async capture(time: number, width: number, height: number): Promise<ArrayBuffer> {
    if (this.destroyed) throw new Error('预演视窗已关闭')
    this.seek(time)
    this.exporting = true
    const helper = this.transform.getHelper(),
      visible = helper.visible
    this.guides.visible = false
    helper.visible = false
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(width, height, false)
    this.renderer.setScissorTest(false)
    this.renderer.setViewport(0, 0, width, height)
    this.renderer.render(this.scene, this.camera)
    try {
      const blob = await new Promise<Blob>((resolve, reject) =>
        this.renderer.domElement.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('无法读取预演画面'))),
          'image/png',
        ),
      )
      return await blob.arrayBuffer()
    } finally {
      this.exporting = false
      helper.visible = visible
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
      this.resize()
    }
  }
  destroy() {
    this.destroyed = true
    this.generation++
    this.observer.disconnect()
    this.orbit.dispose()
    this.transform.dispose()
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown)
    this.renderer.domElement.removeEventListener('pointerup', this.pointerUp)
    this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLost)
    dispose(this.scene)
    this.scene.clear()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.label.remove()
  }
}
