# Cast Manager - Complete Design Specification
## Source of Truth Document

**Project:** Cast Manager Mini App  
**Purpose:** Extend the user's mind with specialized expertise that activates instantly  
**Philosophy:** Mental mode switching should feel like breathing  
**Status:** Design Complete, Implementation Ready

---

## 1. FOUNDATIONAL DECISIONS

### 1.1 Root Purpose (The 5 Whys)
```
Surface: "Manage AI personas"
  ↓
"Switch between expertise modes"
  ↓
"Context switching is cognitively expensive"
  ↓
"Humans can't hold multiple mental models"
  ↓
"Expertise requires deep contextual understanding"
  ↓
ROOT: "Extend the user's mind with specialized expertise that activates instantly, preserving flow state"
```

### 1.2 User Archetype
**The Mental Shapeshifter**
- Wears many hats throughout the day
- Values flow state above all else
- Frustrated by mental "loading screens"
- Sees AI as extension of self, not external tool
- Needs to transition between modes without friction

### 1.3 The Four Pillars

| Pillar | Definition | Design Implication |
|--------|------------|-------------------|
| **IMMEDIACY** | Expertise activates in <200ms | One-tap actions, no loading states, bottom dock navigation |
| **CONTINUITY** | Context is preserved, never lost | Recent memories visible, handoff tracking, scroll position saved |
| **CLARITY** | Always know who you are | Identity header always visible, glowing avatar, explicit "You are" text |
| **FLUIDITY** | Switching feels like breathing | Morph transitions, haptic feedback, smooth micro-interactions |

---

## 2. VISUAL DESIGN SYSTEM

### 2.1 Color Philosophy

**Base: Pure Dark (OLED Black)**
```css
--bg-primary: #000000;      /* Pure black - content is star */
--bg-secondary: #0a0a0a;    /* Cards/containers */
--bg-tertiary: #141414;     /* Elevated elements */
--bg-elevated: #1c1c1c;     /* Highest level */
```
**Why:** 
- Maximum contrast for content
- OLED battery savings
- Professional, focused atmosphere
- Cast colors pop against dark

**Text Hierarchy:**
```css
--text-primary: #ffffff;                    /* Headlines, important */
--text-secondary: rgba(255, 255, 255, 0.7); /* Body text */
--text-tertiary: rgba(255, 255, 255, 0.5);  /* Metadata, hints */
```

**Cast Color System (Dynamic):**
```css
/* Architect - Purple-Blue (Thoughtful, expansive) */
--cast-primary: #667eea;
--cast-glow: rgba(102, 126, 234, 0.5);
--cast-muted: rgba(102, 126, 234, 0.15);

/* Developer - Green (Active, productive) */
--cast-primary: #4ade80;
--cast-glow: rgba(74, 222, 128, 0.5);
--cast-muted: rgba(74, 222, 128, 0.15);

/* Researcher - Amber (Curious, warm) */
--cast-primary: #fbbf24;
--cast-glow: rgba(251, 191, 36, 0.5);
--cast-muted: rgba(251, 191, 36, 0.15);
```

**Why These Colors:**
- Purple = Big picture thinking, creativity (Architect)
- Green = Action, productivity, go (Developer)
- Amber = Exploration, curiosity, investigation (Researcher)
- Each cast FEELS different, reinforcing mental mode

### 2.2 Shape Language

**Border Radius Decisions:**
```css
/* Cards: 20px - Friendly but professional */
border-radius: 20px;

/* Buttons: 12px - Slightly more compact */
border-radius: 12px;

/* Pills/Chips: Full rounded */
border-radius: 20px;

/* Avatars: Perfect circles */
border-radius: 50%;

/* Dock: 24px - iOS style */
border-radius: 24px;
```

**Why 20px for Cards (Not 4px, Not 32px):**
- 4px = Too sharp, aggressive, corporate
- 32px = Too bubbly, playful, casual
- 20px = Sweet spot: modern, friendly, professional

### 2.3 Visual Style: Flat + Subtle Depth (NO Heavy Glassmorphism)

**Decision:** Flat dominant with selective depth cues

**Applied:**
```css
/* Base: Flat */
background: #000000;

/* Cards: Flat with border */
background: #0a0a0a;
border: 1px solid rgba(255, 255, 255, 0.05);

/* Elevation: Subtle layered shadows (not blur) */
box-shadow: 
  0 1px 1px rgba(0,0,0,0.02),
  0 2px 2px rgba(0,0,0,0.02),
  0 4px 4px rgba(0,0,0,0.02);

/* Active states: Glow effect (performance-friendly) */
box-shadow: 0 0 30px var(--cast-glow);
```

**Why Not Heavy Glassmorphism:**
- Backdrop-filter is GPU expensive (60fps risk on mobile)
- Reduces text readability
- Trendy but not timeless
- Our flat + glow approach: Performant, clean, modern

**Why Not Neumorphism:**
- Low contrast (accessibility nightmare)
- Hard to distinguish interactive states
- Trend peaked in 2020
- Not suitable for professional tools

**Why Not Skeuomorphism:**
- Dated aesthetic (2010 era)
- Visual clutter
- Slower cognitive processing
- Doesn't match "instant expertise" purpose

---

## 3. LAYOUT & NAVIGATION

### 3.1 Information Architecture

```
LEVEL 1 (Always Visible): Identity
├─ Header with cast avatar, name, glow
└─ "You are" explicit text

LEVEL 2 (Always Accessible): Navigation  
├─ Bottom dock (cast switcher)
├─ Quick actions (chips)
└─ Tab navigation

LEVEL 3 (Contextual): Content
├─ Profile editor
├─ Document list
├─ Memory timeline
└─ Handoff messages
```

### 3.2 The Bottom Dock (Primary Navigation)

**Decision:** Fixed bottom dock (NOT side drawer, NOT dropdown)

**Why:**
- Thumb zone = fastest access on mobile
- One-tap switching (no hunting)
- Visual confirmation immediate
- iOS-style familiarity
- Always accessible (no gestures to reveal)

**Specifications:**
```css
Position: Fixed bottom
Height: ~90px (including safe area)
Background: #0a0a0a with subtle border
Border radius: 24px (floating effect)
Items: 4 visible + "+" button
Spacing: Even distribution
Active state: Background tint + glow
```

### 3.3 Quick Actions

**Decision:** Horizontal scrollable chips (NOT hamburger menu)

**Actions:**
- 📄 Upload (context documents)
- 🔍 Search (across memories/docs)
- 🕐 Recent (activity timeline)
- 📨 Handoffs (messages from casts)

**Why Horizontal:**
- Thumb can swipe naturally
- Always visible (no hunting)
- Common actions one-tap away
- Doesn't compete with vertical content scroll

### 3.4 Tab Navigation

**Tabs:** Profile | Context | Memory

**Why These Three:**
- Profile: Who you are (identity)
- Context: What you know (documents)
- Memory: What you've learned (history)

**Visual Design:**
- Pill-style tabs (iOS segmented control)
- Active tab: Cast color background
- Smooth sliding indicator

---

## 4. ANIMATION & MOTION

### 4.1 The Morph Transition (Cast Switching)

**Timing:** 200ms total
**Sequence:**
1. User taps cast in dock (haptic: medium)
2. Screen flashes with cast color (100ms, 40% opacity)
3. Color fades out (100ms)
4. New identity revealed
5. Haptic pulse confirms (light)

**Why 200ms:**
- <100ms = Feels instant but not perceived
- 200ms = Perceptually instant but FELT
- >300ms = Starts to feel slow

**Why Flash (Not Fade):**
- Flash = Transformation, metamorphosis
- Fade = Replacement, death/rebirth
- Flash reinforces "you're becoming someone else"

### 4.2 Micro-interactions

**Button Press:**
```css
:active {
  transform: scale(0.95);
  transition: 150ms ease;
}
```

**Why Scale Down (Not Up):**
- Down = Pressing, tactile, button being pushed
- Up = Lifting, feels wrong for press

**Card Press:**
```css
:active {
  transform: scale(0.98);
  background: var(--cast-muted);
}
```

**Avatar Pulse (Active Cast):**
```css
animation: pulse-ring 2s ease-out infinite;
/* Expanding ring shows "alive, active" */
```

### 4.3 Haptic Feedback

**Pattern:**
- **Light (10ms):** Quick actions, tabs, document taps
- **Medium (20ms):** Cast switching, save button
- **Heavy (30ms):** Delete, important confirmations

**Why Haptics:**
- Touch interfaces lack tactile feedback
- Confirms action happened (especially if animation fast)
- Delight factor
- Accessibility for visually impaired

### 4.4 Loading States (NO Spinners)

**Decision:** Shimmer skeletons (NOT spinners)

**Why:**
- Skeletons feel like progress (content coming)
- Spinners feel like waiting (stuck)
- Skeletons maintain layout (less jarring)
- More visually appealing

**Implementation:**
```css
.shimmer {
  background: linear-gradient(
    90deg,
    var(--bg-tertiary) 25%,
    var(--bg-secondary) 50%,
    var(--bg-tertiary) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}
```

---

## 5. MOBILE-SPECIFIC DECISIONS

### 5.1 Thumb Zone Optimization

```
┌─────────────────────────────┐
│        HARD TO REACH        │  ← Top actions: rare, destructive
│           (top)             │
├─────────────────────────────┤
│                             │
│       CONTENT AREA          │  ← Middle: scrolling content
│                             │
├─────────────────────────────┤
│      EASY TO REACH          │  ← Bottom: primary actions
│         (dock)              │
└─────────────────────────────┘
```

**Applied:**
- Primary navigation (dock) = Bottom
- Quick actions = Bottom-aligned horizontal scroll
- Save/Confirm = Bottom (easy to reach)
- Delete/Destructive = Top or require confirmation

### 5.2 Touch Targets

**Minimum: 44px (Apple HIG)**
**Preferred: 48px (Material Design)**

**Applied:**
- Dock items: 44px avatar + padding = ~60px tap area
- Quick actions: ~40px tall with padding
- List items: Full width, 60-70px height
- Buttons: 48px minimum height

### 5.3 Safe Areas

**Respect Device Features:**
```css
/* Notch/Dynamic Island */
padding-top: env(safe-area-inset-top);

/* Home Indicator */
padding-bottom: env(safe-area-inset-bottom);
```

**Applied:**
- Header has extra top padding
- Dock has extra bottom padding
- Content scrolls under safe areas (not blocked)

### 5.4 Performance

**Target: 60fps on iPhone 12 / Pixel 5**

**Optimizations:**
- NO backdrop-filter blur (GPU killer)
- NO heavy box-shadows (use borders instead)
- NO parallax scrolling (simple transforms only)
- Use transform/opacity for animations (GPU accelerated)
- will-change on animated elements

**Avoided:**
- Backdrop-filter (expensive blur)
- Heavy gradients on scroll
- Complex clip-path animations
- Unnecessary re-renders

---

## 6. CONTENT STRATEGY

### 6.1 The "You Are Here" Header

**Components:**
1. Colored line (3px) with glow - Immediate visual cue
2. Glowing avatar (48px) with pulse ring - Identity anchor
3. "You are" text - Explicit clarity
4. Cast name (20px) - Who you are now

**Why This Works:**
- Impossible to miss (takes 20% of screen)
- Reinforces identity constantly
- Color immediately signals mode
- Animation (pulse) shows "alive, active"

### 6.2 Recent Memories (Context Preservation)

**Display:** 3 most recent memories
**Format:**
- Date (relative: "Today", "Yesterday")
- Importance badge (if high/critical)
- Text preview (first 100 chars)
- Left border in cast color

**Why:**
- Shows continuity (you didn't lose context)
- Quick reminder of recent learnings
- Reduces anxiety about switching
- Encourages memory saving

### 6.3 Document List

**Information:**
- Icon (by file type)
- Filename
- Size + Token count (shows value)

**Interaction:**
- Tap to view (future: preview)
- Swipe to delete (future)
- Upload button always visible

### 6.4 Handoff Badges

**Visual:**
- Small circle on avatar
- Number if multiple
- Warning color (amber)

**Why:**
- Shows communication between casts
- Encourages handoff usage
- Alert without being intrusive

---

## 7. INTERACTION PATTERNS

### 7.1 Cast Switching Flow

```
1. User sees dock at bottom
2. User taps desired cast (e.g., "Architect")
3. Haptic: Medium (20ms)
4. Morph overlay flashes purple (200ms)
5. Header updates (new color, avatar, name)
6. Content remains (context preserved)
7. Haptic: Light (10ms) - confirmation
8. User is now "Architect"
```

### 7.2 Document Upload Flow

```
1. User taps "📄 Upload" quick action
2. File picker opens (native)
3. User selects file(s)
4. Shimmer skeleton appears in list
5. Upload progress (if large)
6. Document appears in list with meta
7. Indexed automatically
8. Ready to query
```

### 7.3 Profile Editing Flow

```
1. User on Profile tab
2. Sees name input and profile textarea
3. Makes edits
4. Taps "Save Changes"
5. Button press animation + haptic
6. Toast: "Profile saved"
7. Changes persisted to backend
```

---

## 8. ACCESSIBILITY

### 8.1 Contrast Ratios

| Element | Colors | Ratio | Standard |
|---------|--------|-------|----------|
| Primary text | White on #000 | 21:1 | AAA ✅ |
| Secondary text | 70% white on #000 | 12:1 | AAA ✅ |
| Cast colors | On dark | 4.5:1+ | AA ✅ |

### 8.2 Screen Reader Support

**Semantic HTML:**
- `<header>` for identity
- `<nav>` for dock
- `<main>` for content
- `<button>` for actions (not divs)

**ARIA Labels:**
- "You are currently [Cast Name]"
- "Switch to [Cast Name]"
- "Upload document"

### 8.3 Motion Preferences

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 9. TECHNICAL IMPLEMENTATION

### 9.1 Tech Stack

**Frontend:**
- Vanilla HTML/CSS/JS (no framework needed)
- Telegram WebApp SDK (for haptics/theme)
- Inter font (Apple-like, readable)

**Backend:**
- Node.js + Express
- REST API
- File upload (Multer)
- Cast System integration

**Why No React/Vue:**
- Overkill for this scope
- Vanilla is faster to load
- Easier to maintain
- Better performance on mobile

### 9.2 API Endpoints

```
POST /api/cast-manager
  Actions:
  - listCasts
  - switchCast
  - getProfile
  - saveProfile
  - listContext
  - getMemory
  - getHandoffs

POST /api/cast-manager/upload
  - Multipart form upload
  - Returns: success, file info
```

### 9.3 File Structure

```
workspace/
├── cast-system/
│   ├── server.js              # Combined server (app + API)
│   ├── lib/
│   │   ├── CastManager.js     # Core cast logic
│   │   ├── ContextIndexer.js  # Document search
│   │   └── MemoryRouter.js    # Memory/handoffs
│   └── cli.js                 # CLI tool
├── apps/miniapps/cast-manager/
│   ├── redesigned.html        # New UI (this design)
│   ├── index.html             # Original UI
│   ├── app.json               # Mini App manifest
│   └── DESIGN-DECISIONS.md    # This document
└── casts/                     # Cast storage
    ├── architect/
    ├── developer/
    └── researcher/
```

---

## 10. COMPARISON: BEFORE vs AFTER

| Aspect | Before (Original) | After (Redesigned) | Impact |
|--------|------------------|-------------------|---------|
| **Identity** | Small badge | Full glowing header | 10x more visible |
| **Switching** | Sidebar list | Bottom dock | Thumb-accessible |
| **Transitions** | Instant cut | Morph (200ms) | Feels transformative |
| **Colors** | Generic blue | Cast-specific | Reinforces mental mode |
| **Quick Actions** | None | Always-visible chips | No hunting |
| **Background** | #0f0f0f gray | #000000 pure black | OLED + contrast |
| **Shape** | 12px radius | 20px radius | More friendly |
| **Haptics** | None | Contextual | Tactile feedback |
| **Loading** | Spinners | Shimmer skeletons | Better perceived perf |
| **Navigation** | Top tabs only | Dock + tabs | Dual access |

---

## 11. TESTING CHECKLIST

### Visual
- [ ] Colors change correctly per cast
- [ ] Morph transition smooth (60fps)
- [ ] Header glow visible in daylight
- [ ] Text readable in sunlight
- [ ] Safe areas respected (notch, home indicator)

### Interaction
- [ ] Cast switch < 200ms
- [ ] Haptics fire on actions
- [ ] Touch targets > 44px
- [ ] Bottom dock thumb-accessible
- [ ] Quick actions swipeable

### Functional
- [ ] API responds < 100ms
- [ ] File upload works
- [ ] Profile saves
- [ ] Memory list loads
- [ ] Handoffs display

### Accessibility
- [ ] Contrast ratios pass
- [ ] Screen reader labels
- [ ] Reduced motion respected
- [ ] Font sizes accessible

---

## 12. FUTURE ENHANCEMENTS (Not MVP)

### Phase 2
- [ ] Search across documents
- [ ] Swipe to delete documents
- [ ] Memory search/filter
- [ ] Handoff compose (send messages)
- [ ] Cast analytics (usage stats)

### Phase 3
- [ ] Custom cast creation wizard
- [ ] Template gallery
- [ ] Cast sharing (export/import)
- [ ] Collaboration (shared casts)
- [ ] AI-assisted profile generation

---

## 13. THE FINAL DECISION SUMMARY

**Every decision traces back to:**

> "Extend the user's mind with specialized expertise 
> that activates instantly, preserving flow state"

**Therefore:**
- Identity must be unmistakable → Glowing header
- Switching must be instant → Bottom dock + morph
- Context must be preserved → Recent memories visible
- Experience must be fluid → Haptics + animations
- Visuals must be focused → Pure dark + cast colors

---

## 14. APPROVAL

**Design Status:** ✅ Complete  
**Implementation Status:** 🔄 Ready to build  
**Testing Status:** ⏳ Pending  

**Signed off by:** Design process completed  
**Date:** 2026-02-18  
**Version:** 1.0

---

*This document is the source of truth. All implementation decisions should reference this specification.*
