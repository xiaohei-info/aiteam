import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { EMPLOYEE_ANIMATIONS, AIFRED_RESOURCE_ID, AIFRED_SKINS, AIFRED_TEMPLATES, AIFRED_SKELETON, AIFRED_SKELETON_ORIGINAL, pickEmployeeSkin, employeeAnimation } from '../src/aifred-resources.js'
import { SkeletonJson, Skeleton, Physics } from '@esotericsoftware/spine-core'
import { OFFICE_ACTIONS, OFFICE_FACINGS, OFFICE_PROP_REGIONS, OFFICE_PROPS_SIZE, OFFICE_PROPS_PAGE, DRINK_HAND, officeActionAnimation } from '../src/office-actions.js'
import { patchOfficeAnimation, officeAnimationDiff, hasOfficeAnimationPatch, hasTypingAnimation, TYPING_ANIMATION, TYPING_SOURCE_ANIMATION, TYPING_ARM_BONES, TYPING_HEAD_BONE } from '../src/work-anim.js'
import { makeMap, makeElement, validateMap, syncSeats } from '../src/model.js'
const readJSON = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
const manifest = await readJSON('../assets/aifred/manifest.json')
const skeleton = await readJSON('../assets/aifred/characters/chibi-stickers/chibi-stickers.json')

test('AIFred artwork is a byte-exact snapshot with no hand-designed employee substitutes', async () => {
  assert.equal(manifest.provenance.length, 15)
  for (const entry of manifest.provenance) {
    const data = await readFile(new URL(`../${entry.target}`, import.meta.url))
    assert.equal(data.length, entry.bytes)
    assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, entry.target)
  }
  assert.deepEqual(manifest.skins, AIFRED_SKINS)
  assert.equal(AIFRED_TEMPLATES[0].src, 'assets/aifred/office/desk.png')
})

test('all nine AIFred skins and animation bindings exist in the original Spine skeleton', () => {
  for (const skin of AIFRED_SKINS) assert.ok(skeleton.skins.some(s => s.name === skin))
  for (const facing of ['front', 'back', 'left', 'right']) for (const animation of ['idle', 'walking']) assert.ok(skeleton.animations[employeeAnimation({ animation }, facing)])
  // 思考 / 挥手 / 休息类动作走派生骨骼里的方向动作，按屏幕朝向命名
  assert.equal(employeeAnimation({ animation: 'thinking' }, 'left'), 'office/think-left')
  assert.equal(employeeAnimation({ animation: 'talking' }, 'back'), 'office/talk-back')
  assert.equal(employeeAnimation({ animation: 'tea' }, 'unknown'), 'office/tea-front')
  // 屏幕朝向要映射到名字相反的动画（资源里 left/right 与屏幕相反），否则动作和方向相反
  assert.equal(employeeAnimation({ animation: 'walking' }, 'left'), 'movement/trot-right')
  assert.equal(employeeAnimation({ animation: 'walking' }, 'right'), 'movement/trot-left')
  assert.equal(employeeAnimation({ animation: 'idle' }, 'left'), 'movement/idle-right')
  assert.equal(employeeAnimation({ animation: 'idle' }, 'right'), 'movement/idle-left')
  assert.equal(employeeAnimation({ animation: 'walking' }, 'back'), 'movement/trot-back')
  assert.equal(employeeAnimation({ animation: 'idle' }, 'front'), 'movement/idle-front')
  for (let i = 0; i < 20; i++) assert.equal(pickEmployeeSkin(i), AIFRED_SKINS[(Math.imul(i + 1, 2654435761) >>> 0) % 9])
})

test('employee resource bindings are validated and JSON preserves skin/facing/state', () => {
  const map = makeMap(), desk = makeElement('桌', 'rect', 500, 500)
  map.elements.push(desk)
  map.seats = [{ id: 'seat', name: '工位', deskElementId: desk.id, x: 500, y: 500, facing: 'left', seatOffset: { x: 0.5, y: 0.62 }, employee: { resourceId: AIFRED_RESOURCE_ID, skin: 'misaki', enabled: true, animation: 'thinking', name: '演示员工' } }]
  syncSeats(map)
  assert.equal(map.seats[0].facing, 'left', 'explicit employee facing survives desk sync')
  assert.deepEqual(validateMap(JSON.parse(JSON.stringify(map))), map)
  for (const [key, value] of [['resourceId', 'https://remote/role.json'], ['skin', 'other'], ['animation', '__proto__'], ['name', '<'.repeat(61)], ['enabled', 'yes']]) {
    const changed = structuredClone(map); changed.seats[0].employee[key] = value
    assert.throws(() => validateMap(changed), /员工/)
  }
  const legacy = { ...map, schema: 'office-map/v1' }
  assert.throws(() => validateMap(legacy), /v1.1/)
})

test('bound original chair follows desk moving and resizing without duplicating employee seats', () => {
  const map = makeMap(), desk = makeElement('桌', 'rect', 500, 500), chair = makeElement('椅', 'rect', 500, 500)
  map.elements.push(desk, chair)
  map.seats = [{ id: 'seat', name: '工位', deskElementId: desk.id, chairElementId: chair.id, x: 500, y: 500, facing: 'back', chairOffset: { x: 0.5, y: 0.8 } }]
  desk.x = 700; desk.width = 200; syncSeats(map)
  assert.equal(chair.x, 700)
  assert.ok(Math.abs(chair.width - 116) < 1e-9, 'chair width matches original ratio within floating-point precision')
  assert.ok(Math.abs(chair.height - 116 * 492 / 474) < 1e-9, 'chair preserves original aspect ratio')
  map.seats.push({ ...structuredClone(map.seats[0]), id: 'seat-two' })
  assert.throws(() => validateMap(map), /重复绑定/)
})

test('办公室派生骨骼 = 原骨架 + 打字动画 + 方向动作，走路等原有内容逐字节一致', async () => {
  const derived = await readJSON('../assets/aifred/characters/chibi-stickers/chibi-stickers-walk.json')
  const { patched, stats } = patchOfficeAnimation(skeleton)
  assert.deepEqual(stats, { typingTracks: 10, typingKeys: 57, officeActions: 24 })

  // 派生文件必须与「原骨架 + 补丁」逐字节一致（防止有人手改派生文件后忘了同步）
  assert.deepEqual(derived, patched, 'chibi-stickers-walk.json 与 patchOfficeAnimation(原骨架) 结果不一致，请重新运行 npm run office:anim')

  // 只新增打字动画；走路动画、其它动画与骨架结构不变
  const officeNames = OFFICE_ACTIONS.flatMap((action) => OFFICE_FACINGS.map((facing) => officeActionAnimation(action, facing)))
  assert.deepEqual(officeAnimationDiff(skeleton, derived).sort(), ['bones', 'slots', 'skins', TYPING_ANIMATION, ...officeNames].sort())
  for (const name of Object.keys(skeleton.animations)) assert.deepEqual(derived.animations[name], skeleton.animations[name], `${name} 不应被改动`)
  // 道具骨骼 / 插槽只追加在末尾：绘制顺序时间轴按下标记录偏移，原有下标不能变
  assert.deepEqual(derived.bones.slice(0, skeleton.bones.length), skeleton.bones)
  assert.deepEqual(derived.slots.slice(0, skeleton.slots.length), skeleton.slots)
  assert.deepEqual(derived.skins.slice(1), skeleton.skins.slice(1), '角色皮肤不变，道具贴图只挂在 default 皮肤')
  for (const [slot, attachments] of Object.entries(skeleton.skins[0].attachments ?? {})) assert.deepEqual(derived.skins[0].attachments[slot], attachments)
  assert.deepEqual(derived.ik, skeleton.ik)
  assert.equal(derived.skeleton.spine, skeleton.skeleton.spine)
  assert.equal(hasOfficeAnimationPatch(derived), true)

  // 打字动画：以坐姿 idle-back 为底，只改手臂/头部，首尾一致可无缝循环
  const typing = derived.animations[TYPING_ANIMATION]
  assert.ok(typing, `派生骨骼应包含 ${TYPING_ANIMATION}`)
  assert.equal(TYPING_SOURCE_ANIMATION, 'movement/idle-back')
  assert.equal(hasTypingAnimation(derived), true)
  for (const bone of [...TYPING_ARM_BONES, TYPING_HEAD_BONE]) {
    const keys = typing.bones[bone]?.rotate ?? []
    assert.ok(keys.length >= 2, `${bone} 应有循环摆动轨道`)
    assert.equal(keys[0].value, keys[keys.length - 1].value, `${bone} 首尾取值必须一致，否则循环会跳变`)
  }
  // 身体/髋部/脸部沿用 idle-back，坐姿不会跑偏
  for (const bone of ['body-up', 'hips', 'face-holder']) {
    assert.deepEqual(typing.bones[bone], skeleton.animations[TYPING_SOURCE_ANIMATION].bones[bone], `${bone} 应保持坐姿底动画`)
  }
  // 原骨架并没有打字动画
  assert.equal(skeleton.animations[TYPING_ANIMATION], undefined)

  // 幂等保护：重复添加必须报错
  assert.throws(() => patchOfficeAnimation(derived), /不能重复添加/)
})

/** 只载入骨骼与动画（不需要贴图），用 spine-core 计算骨骼世界坐标 */
function loadBonesOnly(json) {
  const j = structuredClone(json)
  j.skins = [{ name: 'default', attachments: {} }]
  for (const slot of j.slots ?? []) delete slot.attachment
  for (const animation of Object.values(j.animations)) {
    delete animation.slots
    delete animation.deform
    delete animation.drawOrder
  }
  return new SkeletonJson({ newRegionAttachment: () => null }).readSkeletonData(JSON.stringify(j))
}

test('屏幕左右走路：身体朝行进方向，两条腿的膝盖都朝行进方向弯（spine-core 实算）', async () => {
  const derived = await readJSON('../assets/aifred/characters/chibi-stickers/chibi-stickers-walk.json')
  const data = loadBonesOnly(derived)
  for (const [screenSide, travel] of [['right', 1], ['left', -1]]) {
    // 与编辑器/前端一致的映射：屏幕朝右走播放名为 trot-left 的动画
    const name = employeeAnimation({ animation: 'walking' }, screenSide)
    const animation = data.findAnimation(name)
    assert.ok(animation, `${name} 应存在`)
    const sk = new Skeleton(data)
    const frames = 40
    for (const side of ['l', 'r']) {
      const offsets = []
      for (let i = 0; i < frames; i++) {
        sk.setToSetupPose()
        animation.apply(sk, 0, (animation.duration * i) / frames, false, [], 1, 0, 0)
        sk.updateWorldTransform(Physics.update)
        if (side === 'l' && i === 0) {
          const face = sk.findBone('face-holder').worldX - sk.findBone('hips').worldX
          assert.ok(face * travel > 0, `屏幕朝${screenSide}走时脸应朝行进方向（${name}）`)
        }
        const hip = sk.findBone(`leg-up-${side}`)
        const shin = sk.findBone(`leg-down-${side}`)
        const footX = shin.worldX + shin.a * shin.data.length
        const footY = shin.worldY + shin.c * shin.data.length
        const dx = footX - hip.worldX
        const dy = footY - hip.worldY
        const length = Math.hypot(dx, dy) || 1
        // 膝盖到「髋—脚」连线的有符号距离；正值 = 膝盖朝行进方向
        offsets.push((((shin.worldX - hip.worldX) * -dy + (shin.worldY - hip.worldY) * dx) / length) * travel)
      }
      const backward = offsets.filter((v) => v < -15).length
      const mean = offsets.reduce((sum, v) => sum + v, 0) / frames
      assert.equal(backward, 0, `${name} leg-${side}：${backward}/${frames} 帧膝盖朝身后弯（反关节）`)
      assert.ok(mean > 15, `${name} leg-${side}：膝盖平均应明显朝前（实际 ${mean.toFixed(1)}）`)
    }
  }
})

test('渲染用骨骼指向修正版，原骨架仍保持 byte-exact 快照', async () => {
  assert.match(AIFRED_SKELETON, /chibi-stickers-walk\.json$/)
  assert.equal(AIFRED_SKELETON_ORIGINAL, 'assets/aifred/characters/chibi-stickers/chibi-stickers.json')
  const manifestEntry = manifest.provenance.find((entry) => entry.target === AIFRED_SKELETON_ORIGINAL)
  assert.ok(manifestEntry, '原骨架必须在 provenance 清单里')
  const original = await readFile(new URL(`../${AIFRED_SKELETON_ORIGINAL}`, import.meta.url))
  assert.equal(original.length, manifestEntry.bytes)
})

test('方向动作：每个动作 4 个方向都存在，骨骼能被 spine-core 解算', async () => {
  const derived = await readJSON('../assets/aifred/characters/chibi-stickers/chibi-stickers-walk.json')
  for (const animation of Object.keys(EMPLOYEE_ANIMATIONS)) for (const facing of OFFICE_FACINGS) assert.ok(derived.animations[employeeAnimation({ animation }, facing)], `员工预览 ${animation}-${facing} 缺动画`)
  const data = loadBonesOnly(derived)
  for (const action of OFFICE_ACTIONS) for (const facing of OFFICE_FACINGS) {
    const name = officeActionAnimation(action, facing)
    const animation = data.findAnimation(name)
    assert.ok(animation, `${name} 应存在`)
    const sk = new Skeleton(data)
    sk.setToSetupPose()
    animation.apply(sk, 0, 0.6, false, [], 1, 0, 0)
    sk.updateWorldTransform(Physics.update)
    for (const bone of sk.bones) assert.ok(Number.isFinite(bone.worldX) && Number.isFinite(bone.worldY), `${name} ${bone.data.name} 坐标无效`)
  }
})

test('坐下：髋部落在锚点（座位中心），侧面膝盖朝上、脚在面向一侧（spine-core 实算）', async () => {
  const derived = await readJSON('../assets/aifred/characters/chibi-stickers/chibi-stickers-walk.json')
  const data = loadBonesOnly(derived)
  for (const facing of OFFICE_FACINGS) {
    const sk = new Skeleton(data)
    sk.setToSetupPose()
    data.findAnimation(officeActionAnimation('sit', facing)).apply(sk, 0, 0.6, false, [], 1, 0, 0)
    sk.updateWorldTransform(Physics.update)
    const hips = sk.findBone('hips')
    assert.ok(Math.abs(hips.worldY) < 12, `sit-${facing}：髋部应在锚点附近（实际 y=${hips.worldY.toFixed(1)}）`)
    const side = facing === 'left' ? -1 : facing === 'right' ? 1 : 0
    if (!side) continue
    for (const leg of ['l', 'r']) {
      const hip = sk.findBone(`leg-up-${leg}`), shin = sk.findBone(`leg-down-${leg}`)
      const footX = shin.worldX + shin.a * shin.data.length, footY = shin.worldY + shin.c * shin.data.length
      assert.ok((footX - hip.worldX) * side > 40, `sit-${facing} leg-${leg}：脚应在面向一侧`)
      assert.ok(shin.worldY > footY, `sit-${facing} leg-${leg}：膝盖应高于脚（不反关节）`)
    }
  }
})

test('喝茶 / 喝咖啡：杯子贴图在派生图集里，道具页尺寸与贴图一致，背面不显示杯子', async () => {
  const derived = await readJSON('../assets/aifred/characters/chibi-stickers/chibi-stickers-walk.json')
  const atlas = await readFile(new URL('../assets/aifred/characters/chibi-stickers/chibi-stickers-office.atlas', import.meta.url), 'utf8')
  const original = await readFile(new URL('../assets/aifred/characters/chibi-stickers/chibi-stickers.atlas', import.meta.url), 'utf8')
  assert.ok(atlas.startsWith(original.trimEnd()), '派生图集应以原图集开头')
  for (const name of Object.keys(OFFICE_PROP_REGIONS)) assert.match(atlas, new RegExp(`^${name}$`, 'm'))
  const png = await readFile(new URL(`../assets/aifred/characters/chibi-stickers/${OFFICE_PROPS_PAGE}`, import.meta.url))
  assert.deepEqual({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, OFFICE_PROPS_SIZE)
  const regions = new Set(Object.keys(OFFICE_PROP_REGIONS))
  for (const kind of ['tea', 'coffee']) for (const facing of OFFICE_FACINGS) {
    const slots = derived.animations[officeActionAnimation(kind, facing)].slots ?? {}
    const cup = slots[`office-cup-${DRINK_HAND[facing]}`]
    if (facing === 'back') { assert.equal(cup, undefined, `${kind}-back 看不到杯子`); continue }
    assert.ok(cup && regions.has(cup.attachment[0].name), `${kind}-${facing} 应拿着杯子`)
  }
})
