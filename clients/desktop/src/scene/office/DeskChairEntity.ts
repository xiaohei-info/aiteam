/**
 * 办公桌椅实体封装
 *
 * 将桌子、椅子和员工角色组合成一个独立的工作站单元。
 * 便于统一管理和复用。
 */

import { Container, Sprite, Text, Graphics, type Texture } from 'pixi.js'
import { SpineCharacter } from './SpineCharacter'
import { pickCharacterSkin, type ChibiFacing } from '@/config/office/characters'

/** 桌椅原图尺寸 */
const DESK_PNG_SIZE = { w: 920, h: 582 }
const CHAIR_PNG_SIZE = { w: 474, h: 492 }
const COMPUTER_PNG_SIZE = { w: 400, h: 300 } // 电脑底图尺寸（显示器外框）
const SCREEN_SIZE = { w: 320, h: 180 } // 屏幕内容区域尺寸（相对于电脑底图）

/** 桌椅锚点（与 OfficeScene 保持一致） */
const DESK_ANCHOR_Y = 0.62
const CHAIR_ANCHOR_Y = 0.36
const COMPUTER_ANCHOR_Y = 0.88 // 电脑锚点

/** 椅子相对桌子的宽度比例 */
const CHAIR_TO_DESK_RATIO = 0.58
/** 电脑相对桌子的宽度比例 */
const COMPUTER_TO_DESK_RATIO = 0.25
/** 员工相对椅子的宽度比例 */
const CHARACTER_TO_CHAIR_RATIO = 1.1
/** 员工 Spine 参考宽度 */
const SPINE_REFERENCE_WIDTH = 200
/** 员工头顶相对椅子中心的上移比例 */
const CHARACTER_HEAD_LIFT_RATIO = 0

export interface DeskChairOptions {
  /** 工位索引，用于分配角色皮肤 */
  seatIndex: number
  /** 员工姓名 */
  employeeName: string
  /** 员工职位 */
  employeeRole?: string
  /** 桌子宽度（像素） */
  deskWidth: number
  /** 桌子纹理 */
  deskTexture: Texture
  /** 椅子纹理 */
  chairTexture: Texture
  /** 电脑纹理 */
  computerTexture?: Texture
  /** 员工朝向 */
  facing?: ChibiFacing
  /** 是否启用 Spine 角色动画 */
  enableSpine?: boolean
}

/**
 * 办公桌椅实体
 *
 * 层级结构：
 * - DeskChairEntity (Container)
 *   - desk (Sprite) - 桌子
 *   - computer (Container) - 电脑
 *     - computerBase (Sprite) - 电脑底图（显示器外框）
 *     - computerScreen (Sprite) - 屏幕内容gif
 *   - character (SpineCharacter | Graphics) - 员工角色
 *   - nameCard (Container) - 员工名片
 *   - chair (Sprite) - 椅子（最上层，形成遮挡）
 */
export class DeskChairEntity extends Container {
  private desk: Sprite
  private computer: Container
  private computerBase: Sprite
  private computerScreen: Sprite
  private chair: Sprite
  private character: SpineCharacter | Graphics
  private nameCard: Container

  constructor(private options: DeskChairOptions) {
    super()

    const deskScale = options.deskWidth / DESK_PNG_SIZE.w
    const chairWidth = options.deskWidth * CHAIR_TO_DESK_RATIO
    const chairScale = chairWidth / CHAIR_PNG_SIZE.w
    const chairHeightPx = CHAIR_PNG_SIZE.h * chairScale

    // 1. 桌子
    this.desk = new Sprite(options.deskTexture)
    this.desk.anchor.set(0.5, DESK_ANCHOR_Y)
    this.desk.scale.set(deskScale)
    this.addChild(this.desk)

    // 2. 电脑（在桌子上方，人物下方）
    const computerWidth = options.deskWidth * COMPUTER_TO_DESK_RATIO
    const computerScale = computerWidth / COMPUTER_PNG_SIZE.w

    this.computer = new Container()

    // 2.1 电脑底图（显示器外框 + 底座）
    this.computerBase = new Sprite()
    this.computerBase.anchor.set(0.5, COMPUTER_ANCHOR_Y)
    this.computerBase.scale.set(computerScale)

    if (options.computerTexture) {
      this.computerBase.texture = options.computerTexture
      console.log('[DeskChairEntity] 电脑底图纹理尺寸:', {
        width: options.computerTexture.width,
        height: options.computerTexture.height,
      })
    } else {
      // 占位符：显示一个矩形表示电脑位置
      console.log('[DeskChairEntity] 电脑底图缺失，使用占位符')
    }
    this.computer.addChild(this.computerBase)

    // 2.2 屏幕内容区域（用于显示工作状态gif）
    const screenScale = (computerWidth / COMPUTER_PNG_SIZE.w) * (SCREEN_SIZE.w / SCREEN_SIZE.w)
    this.computerScreen = new Sprite()
    this.computerScreen.anchor.set(0.5, 0.5)
    this.computerScreen.scale.set(screenScale)
    // 屏幕相对于电脑底图的位置（根据实际底图调整）
    this.computerScreen.position.set(0, -COMPUTER_PNG_SIZE.h * 0.15 * computerScale)
    this.computer.addChild(this.computerScreen)

    console.log('[DeskChairEntity] 电脑尺寸调试:', {
      deskWidth: options.deskWidth,
      COMPUTER_TO_DESK_RATIO,
      computerWidth,
      computerScale,
      screenScale,
      screenPosition: this.computerScreen.position,
    })

    // 电脑位置：在桌子上，靠后一些，让屏幕更高
    this.computer.position.set(0, -chairHeightPx * 0.5)
    this.addChild(this.computer)

    // 计算员工位置
    const characterY = -chairHeightPx * CHARACTER_HEAD_LIFT_RATIO

    // 3. 员工角色
    if (options.enableSpine) {
      const skin = pickCharacterSkin(options.seatIndex)
      const targetSpineWidth = chairWidth * CHARACTER_TO_CHAIR_RATIO
      const spineScale = targetSpineWidth / SPINE_REFERENCE_WIDTH
      const char = new SpineCharacter({
        skin,
        facing: options.facing ?? 'back',
        scale: spineScale,
      })
      char.position.set(0, characterY)
      char.playIdle()
      this.character = char
    } else {
      // 降级：使用简单的圆形占位符
      const placeholder = new Graphics()
      placeholder.circle(0, -chairHeightPx * 0.3, chairWidth * 0.25)
      placeholder.fill({ color: 0x4a90e2, alpha: 0.7 })
      this.character = placeholder
    }
    this.addChild(this.character)

    // 4. 员工名片（头顶显示姓名和职位）- 相对于员工位置计算
    this.nameCard = this.createNameCard(characterY, chairHeightPx)
    this.addChild(this.nameCard)

    // 5. 椅子（最上层）
    this.chair = new Sprite(options.chairTexture)
    this.chair.anchor.set(0.5, CHAIR_ANCHOR_Y)
    this.chair.scale.set(chairScale)
    this.addChild(this.chair)
  }

  /**
   * 创建员工名片：显示姓名和职位
   */
  private createNameCard(_characterY: number, chairHeightPx: number): Container {
    const card = new Container()

    const padding = 8
    const nameText = this.options.employeeName
    const roleText = this.options.employeeRole || '员工'

    // 姓名文本（较大，金色）
    const name = new Text({
      text: nameText,
      style: {
        fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
        fontSize: 22,
        fontWeight: '600',
        fill: 0xFFD700,  // 金色
      },
    })
    name.anchor.set(0.5, 0)
    name.position.set(0, padding)

    // 职位文本（较小，灰金色）
    const role = new Text({
      text: roleText,
      style: {
        fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
        fontSize: 22,
        fontWeight: '400',
        fill: 0xCCCCCC,  // 灰金色
      },
    })
    role.anchor.set(0.5, 0)
    role.position.set(0, padding + name.height + 3)

    // 计算背景尺寸
    const cardWidth = Math.max(name.width, role.width) + padding * 2
    const cardHeight = name.height + role.height + padding * 2 + 3

    // 绘制圆角矩形背景（从 0 开始，相对于 card 容器）
    const bg = new Graphics()
    bg.roundRect(-cardWidth / 2, 0, cardWidth, cardHeight, 6)
    bg.fill({ color: 0xffffff, alpha: 0.0 })
    bg.roundRect(-cardWidth / 2, 0, cardWidth, cardHeight, 6)
    bg.stroke({ color: 0xe0e0e0, width: 1, alpha: 0.0 })

    // 使用 chairHeightPx 计算名片位置
    const cardY = -chairHeightPx * 1.2 * 1.6
    card.position.set(0, cardY)
    card.addChild(bg, name, role)

    return card
  }

  /**
   * 更新员工信息
   */
  updateEmployee(name: string, role?: string) {
    this.options.employeeName = name
    this.options.employeeRole = role
    this.removeChild(this.nameCard)
    this.nameCard.destroy({ children: true })

    // 重新计算员工位置
    const chairScale = (this.options.deskWidth * CHAIR_TO_DESK_RATIO) / CHAIR_PNG_SIZE.w
    const chairHeightPx = CHAIR_PNG_SIZE.h * chairScale
    const characterY = -(chairHeightPx * CHARACTER_HEAD_LIFT_RATIO)

    this.nameCard = this.createNameCard(characterY, chairHeightPx)
    this.addChildAt(this.nameCard, this.children.indexOf(this.chair))
  }

  /**
   * 设置电脑屏幕状态
   * @param status 状态类型：'working' | 'browsing' | 'coding' | 'idle'
   */
  setComputerScreenStatus(status: 'working' | 'browsing' | 'coding' | 'idle') {
    if (!this.computerScreen) return

    // 根据状态加载对应的屏幕内容gif
    const gifUrls: Record<string, string> = {
      working: '/assets/office/screen-working.gif',
      browsing: '/assets/office/screen-browsing.gif',
      coding: '/assets/office/screen-coding.gif',
      idle: '/assets/office/screen-idle.gif',
    }

    const url = gifUrls[status]
    if (url) {
      // 使用 PixiJS 加载 gif 作为纹理
      import('pixi.js').then(({ Assets }) => {
        Assets.load(url).then((texture) => {
          if (this.computerScreen) {
            this.computerScreen.texture = texture as any
            console.log(`[DeskChairEntity] 屏幕状态切换为 ${status}`)
          }
        }).catch((err) => {
          console.warn(`[DeskChairEntity] 加载屏幕状态 ${status} 失败`, err)
        })
      })
    }
  }

  /**
   * 播放思考动画
   */
  playThinking() {
    if (this.character instanceof SpineCharacter) {
      this.character.playThinking()
    }
  }

  /**
   * 播放说话动画
   */
  playTalking() {
    if (this.character instanceof SpineCharacter) {
      this.character.playTalking()
    }
  }

  /**
   * 恢复空闲动画
   */
  playIdle() {
    if (this.character instanceof SpineCharacter) {
      this.character.playIdle()
    }
  }

  /**
   * 播放走动动画
   */
  playWalking() {
    if (this.character instanceof SpineCharacter) {
      this.character.playWalking()
    }
  }

  /**
   * 设置员工朝向
   */
  setFacing(facing: ChibiFacing) {
    if (this.character instanceof SpineCharacter) {
      this.character.setFacing(facing)
    }
  }

  /**
   * 获取员工角色的世界坐标
   */
  getCharacterWorldPosition(): { x: number; y: number } {
    return {
      x: this.x + this.character.x,
      y: this.y + this.character.y,
    }
  }

  /**
   * 设置员工角色的位置（相对于工位容器）
   */
  setCharacterPosition(x: number, y: number) {
    this.character.x = x
    this.character.y = y
    // 名片跟随员工移动（保持相对位置）
    this.nameCard.x = x
    // 名片的 y 坐标需要保持相对于员工的偏移量
    // 原始名片位置是相对于初始 characterY 计算的
    const chairScale = (this.options.deskWidth * CHAIR_TO_DESK_RATIO) / CHAIR_PNG_SIZE.w
    const chairHeightPx = CHAIR_PNG_SIZE.h * chairScale
    const cardOffsetY = -chairHeightPx * 1.2 * 1.6
    this.nameCard.y = y + cardOffsetY
  }

  /**
   * 获取员工角色的位置（相对于工位容器）
   */
  getCharacterPosition(): { x: number; y: number } {
    return {
      x: this.character.x,
      y: this.character.y,
    }
  }

  destroy() {
    if (this.character instanceof SpineCharacter) {
      this.character.destroySpine()
    }
    super.destroy({ children: true })
  }
}
