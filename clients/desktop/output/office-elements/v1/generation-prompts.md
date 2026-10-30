# 后续生成规格（未执行）

本批使用本地原图裁切，没有使用内置生图或 CLI/API。以下规格为后续元素补全准备。

## 家具、绿植与装饰通用规格

Use case: background-extraction
Asset type: office game prop sprite
Input images: Image 1 is the matching crop in crops/ (edit target); Image 2 is the original office image (style reference).
Primary request: Isolate only the named subject from Image 1. Preserve its design, proportions, colors and materials. Reconstruct obscured parts only where needed for a complete standalone object.
Style/medium: realistic miniature architectural render matching the original office; white plaster, neutral gray surfaces, warm wood, black metal frames, natural foliage as applicable.
Composition/framing: preserve the source viewing direction and elevated camera angle; show the entire subject with padding. One object per output. No labels, no border, no room background.
Lighting: soft neutral light matching the reference; no new dramatic lighting or baked floor patch.
Background: genuine transparent alpha, not a checkerboard painted into the image.
Constraints: no redesign, no unrelated props, no invented logos. Preserve fine leaf edges. Output is a first visual sample, not yet a validated production sprite.

Subject selection: use the label and crop from manifest.json. For 18 remove the tabletop plant if producing the table alone. For 20 create separate table and chair outputs. For 21 create separate cabinetry and countertop equipment outputs. For 24 create separate island and stool outputs. For 27 create separate toilet, partition and door outputs. Do not generate all distinct objects in one sprite sheet.

## 建筑模块

Use case: stylized-concept
Asset type: modular office game architecture
Input images: Image 1 is the matching architecture crop; Image 2 is the complete original office, both style references.
Primary request: Create one reusable module matching the reference: a straight white wall segment, wall corner, black-framed window, glass partition, wooden door or glass entrance door. Generate each subject separately.
Style/medium: realistic miniature architectural render. Match the original wall thickness, white plaster, gray skirting and black frames.
Composition/framing: fixed elevated camera direction consistent across modules, parallel projection for modular assembly. Complete object, no surrounding room, no extra decoration.
Constraints: window and door modules must fit wall openings. Preserve glass transparency. Door frame and leaf need separate outputs for animation. Genuine transparent background when supported by the selected generation tool. No text, no watermark.

## 地板纹理

Use case: stylized-concept
Asset type: tileable game texture
Input images: one of crops/08-carpet-light.png, crops/09-carpet-dark.png, crops/10-floor-tile.png (material reference).
Primary request: Reconstruct the reference material as a seamless square floor texture, preserving the pattern scale and neutral gray palette.
Composition/framing: orthographic top-down, edge-to-edge opaque texture.
Lighting: uniform albedo-like appearance, no perspective, no directional shadows or highlights.
Constraints: seamless on both axes; no objects, borders, typography or watermark. Validate in a repeated 3 by 3 layout before use.
