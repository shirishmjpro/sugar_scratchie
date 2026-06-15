# Sugar Scratchie Product Vision Document

## 1. Product Overview

Sugar Scratchie is an interactive scratch-card style game that uses realistic human video content instead of traditional static scratch cards.

Players scratch clothing regions displayed over a video of a real person to reveal hidden symbols, rewards, or collectible items underneath. The core innovation is that scratched areas remain attached to the clothing or body region as the person moves within the video.

The product should feel closer to an interactive game than a conventional lottery ticket.

## 2. Vision

Traditional scratch cards are static images. Sugar Scratchie transforms scratching into a video-based interactive experience where:

- A realistic video plays in the background.
- Clothing regions are scratchable.
- Hidden symbols are revealed beneath the clothing layer.
- Scratches move naturally with the clothing or body as the video plays.
- Players discover prizes, collectibles, and rewards through interaction.

The long-term vision is to create a new kind of video-native scratch game where motion, touch, reveal mechanics, and reward discovery feel connected and physical.

## 3. Core Product Promise

The defining experience is:

> Scratch a moving garment region on a real video, reveal a hidden symbol, and have the scratch stay attached to that garment as the body moves.

If this experience feels natural, the main product risk has been validated. If scratches appear detached from the body, the core illusion fails.

## 4. Primary Technical Challenge

The biggest technical challenge is not the scratch interaction itself. The biggest challenge is maintaining alignment between:

- Video content
- Scratch masks
- Hidden symbols
- Body movement
- Clothing deformation

The system must support realistic movement such as:

- Moving arms
- Moving torso
- Clothing deformation
- Partial body rotation
- Minor occlusion

Scratches must not appear to float over the video or remain fixed to screen coordinates.

## 5. Key Product Principle

Scratches must be attached to garment space, not screen space.

Incorrect behavior:

- A scratch remains at screen position `x=300, y=500` while the person moves.

Correct behavior:

- A scratch remains attached to the left sleeve and follows the sleeve as the arm moves.

The product should model scratchable areas using local clothing coordinates, body-part coordinates, or UV-style normalized coordinates. Hidden symbols should also be stored and rendered in garment space.

## 6. Product Assumptions

Current assumptions for early development:

1. Videos are recorded specifically for the platform.
2. All performers are consenting adults.
3. The camera is generally fixed.
4. Videos are short looping clips.
5. The body remains mostly visible.
6. Clothing regions are clearly identifiable.
7. Gameplay is mobile-first.
8. MVP content can be constrained to reduce tracking complexity.

These assumptions may change later, but they should be preserved for the MVP to keep the first prototype focused on the core technical risk.

## 7. Target Experience

The user experience should be direct and tactile:

1. Player opens a card.
2. Video begins playing.
3. Player scratches visible clothing regions.
4. Hidden symbols become visible.
5. Enough of a symbol is revealed.
6. Reward is triggered.
7. Card is completed.
8. Player proceeds to the next card.

The interface should prioritize the video, the scratch interaction, and the reward reveal. Secondary systems should not distract from validating the core mechanic.

## 8. MVP Scope

The MVP should prove that:

1. Video can play smoothly.
2. Clothing regions can be scratched.
3. Scratches follow body movement.
4. Hidden symbols can be revealed.
5. Rewards can be triggered when reveal thresholds are met.
6. The experience performs acceptably on mobile.

Everything else is secondary until this loop works.

## 9. Out Of Scope For MVP

The MVP should not include:

- Payment systems
- Creator marketplace
- User accounts
- Multiplayer
- Social features
- Advanced AI
- Analytics dashboards
- Complex economy systems
- Full content moderation tooling

These features may become important later, but adding them before validating the moving scratch mechanic would increase cost and complexity without reducing the core product risk.

## 10. Card Content Model

A card consists of:

- Video
- Scratchable regions
- Hidden symbols
- Reward rules

Example structure:

```text
Card
|-- Video
|-- Torso Region
|-- Left Sleeve Region
|-- Right Sleeve Region
|-- Symbol Set
|-- Reward Configuration
```

## 11. Scratch System

The scratch system should support:

- Mouse input
- Touch input
- Multi-touch in a future phase

The system should:

1. Detect pointer or touch input.
2. Determine which garment region was touched.
3. Convert the touch point into garment-space coordinates.
4. Paint the scratch mask in garment space.
5. Re-render the region so the revealed content stays aligned with movement.

The scratch mask should be independent from screen coordinates and video frame coordinates wherever possible.

## 12. Hidden Symbols

Hidden symbols should initially be treated as decals attached to garment regions.

Example symbol types:

- Coin
- Star
- Gem
- Lucky number
- Badge
- Ticket
- Collectible item

MVP symbols should avoid floating 3D objects. They should be stored in garment space and rendered underneath the scratchable clothing layer.

Example placement:

```text
left_sleeve
  symbol_01

torso
  symbol_02

right_sleeve
  symbol_03
```

## 13. Reward System

MVP reward types:

- Coins
- Points
- Collectibles

Reward trigger:

- A reward is triggered when symbol visibility exceeds a configured threshold.

Suggested MVP threshold:

- `70%` symbol visibility

Each symbol may only be claimed once.

## 14. Video Strategy

Recommended MVP video constraints:

- Fixed camera
- Small body movement
- Good lighting
- Consistent framing
- Minimal occlusion
- Short looping clip
- Clearly visible clothing regions

Avoid during MVP:

- Fast dancing
- Large rotations
- Camera movement
- Frequent cropping
- Heavy occlusion
- Low contrast between clothing and background

These constraints are intentional. The MVP should validate the interaction under controlled conditions before expanding to harder video content.

## 15. Tracking Strategy

### Phase 1: Manual Region Definition

The first prototype should use manually defined regions. A developer defines polygons for:

- Torso
- Left arm
- Right arm

No AI tracking is required for the first proof of concept if the video content is tightly constrained.

### Phase 2: Pose Tracking

After the manual prototype validates the core interaction, investigate pose tracking to update garment regions dynamically.

Candidate technologies:

- MediaPipe Pose
- BlazePose
- OpenPose

### Phase 3: Clothing Segmentation

Future work may investigate garment-level segmentation and video object tracking.

Candidate technologies:

- Segment Anything Model
- Video object segmentation
- Garment segmentation models

This phase should not be included in the MVP unless manual and pose-based tracking fail to meet product requirements.

## 16. Suggested Technical Direction

Recommended MVP approach:

- Web prototype
- React
- TypeScript
- Canvas or WebGL rendering
- PixiJS or a custom renderer

Alternative:

- Unity

The recommended starting point is a web prototype rather than Unity. A React, TypeScript, and Canvas/PixiJS prototype should be sufficient to validate the hardest product risk while keeping iteration speed high.

Potential backend direction:

- Go
- PostgreSQL

Storage requirements:

- Videos
- Card definitions
- Scratchable region definitions
- Symbol placements
- Reward configurations

The backend is not critical for the first local prototype. Early work can use static JSON card definitions.

## 17. Initial Data Model

### Card

- `id`
- `title`
- `video`
- `rewardConfig`

### Region

- `id`
- `cardId`
- `type`
- `polygon`
- `mask`

### Symbol

- `id`
- `regionId`
- `rewardType`
- `rewardValue`
- `uvBounds`

## 18. Success Criteria

The prototype is successful when:

1. A video plays smoothly.
2. The user can scratch a clothing region.
3. Scratches remain attached to the moving body region.
4. Hidden symbols appear as the user scratches.
5. Rewards trigger correctly after the reveal threshold is met.
6. Performance remains smooth on a representative mobile device.

The most important success criterion is alignment. A visually simple prototype that keeps scratches attached to clothing is more valuable than a polished game UI with unstable tracking.

## 19. Immediate Milestone

The first milestone should be a single prerecorded video with:

- One tracked arm or sleeve region
- One hidden symbol
- One scratch mask
- One reward trigger

Milestone statement:

> Scratch a moving sleeve on a real video, reveal a symbol, and keep the scratch attached to the sleeve while the arm moves.

This milestone validates the hardest part before investing in game systems, rewards, economy, accounts, content pipelines, or monetization.

## 20. Open Questions

The following decisions are unresolved:

1. Web app vs native app first
2. React vs Unity
3. Manual tracking vs AI tracking
4. Single card vs progression system
5. Coin economy design
6. Creator-generated content
7. AI-generated content
8. Monetization model
9. Reward balancing
10. Content moderation workflow
11. Legal and compliance requirements by market
12. Age gating and identity requirements
13. Performer release and content licensing workflow
14. App store policy constraints

These questions should be answered before production development.

## 21. Risks

### Technical Risk

The scratch mask may not remain convincingly attached to moving clothing. This is the primary risk and should be tested first.

### Content Production Risk

Videos may need strict production constraints to make tracking reliable. This could affect cost, scalability, and creative flexibility.

### Performance Risk

Mobile devices may struggle with video playback, scratch mask rendering, region tracking, and reward calculations if the rendering pipeline is inefficient.

### Compliance Risk

The product includes reward mechanics and realistic human video content. Legal, age-gating, content moderation, performer consent, and platform policy requirements must be clarified before public launch.

## 22. Product Development Recommendation

Start with a constrained web prototype using React, TypeScript, and Canvas or PixiJS.

Do not start with the marketplace, payment system, full reward economy, or AI content pipeline. Build the smallest possible proof of concept that validates garment-space scratching on moving video.

If that works, the product can move into broader game design, content tooling, rewards, and distribution strategy. If it does not work, the project should revisit the tracking model before expanding scope.
