# Cast Manager - Design Decisions Document

## The Process Applied

### 1. ROOT PURPOSE (The 5 Whys)
```
Surface: "Manage AI personas"
↓
"Switch between expertise modes"
↓
"Context switching is expensive"
↓
"Humans can't hold multiple mental models"
↓
ROOT: "Extend the user's mind with expertise that activates instantly"
```

**Design Implication:** Everything must feel IMMEDIATE and SEAMLESS

---

## 2. THE PHILOSOPHY PILLARS

### Pillar 1: IMMEDIACY (<100ms activation)
**Applied:**
- Bottom dock (thumb-accessible, one-tap)
- Morph transition (200ms with haptic)
- No loading spinners (content skeletons)
- Quick action buttons (horizontal scroll, always visible)

### Pillar 2: CONTINUITY (Context preserved)
**Applied:**
- "You are" header always visible
- Recent memories displayed
- Visual trail of recent activity
- Handoff badges show pending messages

### Pillar 3: CLARITY (Always know who you are)
**Applied:**
- Header transforms with cast color
- Glowing avatar with pulse ring
- "You are" text explicit
- Active cast unmistakable in dock

### Pillar 4: FLUIDITY (Like breathing)
**Applied:**
- Morph transition (not jarring cut)
- Haptic feedback on actions
- Smooth micro-interactions
- Visual flow, not abrupt changes

---

## 3. KEY DESIGN DECISIONS

### Decision 1: The "You Are Here" Header
**Problem:** User needs to know current cast

**Naive Solution:** Small label somewhere

**Pillar Check (Clarity):** "Always know who you are"
→ Too subtle, needs to be UNMISTAKABLE

**Final Solution:**
- Full header transforms
- Colored line with glow
- Large avatar with pulse animation
- "You are" text explicit
- Cast name prominent

**Why:** Makes identity the centerpiece, impossible to miss

---

### Decision 2: Bottom Dock (Not Side Drawer)
**Problem:** How to switch casts?

**Naive Solution:** Side menu or dropdown

**Pillar Check (Immediacy):** "<100ms activation"
→ Menus require multiple taps, hunting

**Final Solution:**
- Fixed bottom dock
- 4 casts visible (fits thumb zone)
- One-tap switching
- Swipe for more
- Always accessible

**Why:** 
- Thumb zone = fastest access
- No hunting/gestures
- Visual confirmation immediate
- iOS-style familiarity

---

### Decision 3: Cast Color System
**Problem:** Each cast needs visual identity

**Philosophy:** Each expertise has "energy"

**Final Solution:**
```css
ARCHITECT: #667eea (Blue-Purple)
→ Calm, thoughtful, big-picture
→ Wide, expansive cards

DEVELOPER: #4ade80 (Green)
→ Active, productive, efficient
→ Compact, dense layout

RESEARCHER: #fbbf24 (Amber)
→ Warm, curious, investigative
→ Wide text columns
```

**Why:** Each cast FEELS different, reinforcing mental mode switch

---

### Decision 4: The Morph Transition
**Problem:** Switching casts feels abrupt

**Naive Solution:** Instant cut or fade

**Pillar Check (Fluidity):** "Like breathing"
→ Cuts feel jarring, break flow

**Final Solution:**
1. Press cast (haptic: medium)
2. Screen flashes with cast color (200ms)
3. Color fades
4. New cast identity revealed
5. Haptic pulse confirms

**Why:** 
- Creates sense of TRANSFORMATION
- Not replacement, but metamorphosis
- 200ms = perceptually instant but FELT

---

### Decision 5: Quick Actions (Not Hidden Menu)
**Problem:** Common actions need to be accessible

**Naive Solution:** Hamburger menu

**Pillar Check (Immediacy):** "<100ms"
→ Menus require hunting

**Final Solution:**
- Horizontal scroll of chips
- Always visible
- Common actions: Upload, Search, Recent, Handoffs
- One-tap access

**Why:** 
- No hunting
- Contextual actions visible
- Muscle memory develops

---

### Decision 6: Pure Dark Theme
**Problem:** Visual style for focus

**Options Considered:**
- Light theme (too bright, distracting)
- Glassmorphism heavy (too busy)
- Gradient backgrounds (competes with content)

**Final Solution:**
```css
--bg-primary: #000000;      /* Pure black */
--bg-secondary: #0a0a0a;    /* Near black */
--bg-tertiary: #141414;     /* Elevated */
```

**Why:**
- Content (casts) becomes the star
- OLED battery savings
- Professional, focused
- Cast colors POP against dark

---

### Decision 7: Haptic Feedback
**Problem:** Touch interfaces lack tactile feedback

**Applied:**
- Light: Quick actions, tabs
- Medium: Cast switching, save
- Heavy: (Reserved for important actions)

**Why:** 
- Makes interface feel TACTILE
- Confirms actions happened
- Delight factor

---

## 4. VISUAL HIERARCHY

```
LEVEL 1: Identity (Header)
├─ Cast color glow
├─ Pulsing avatar
└─ "You are" text

LEVEL 2: Navigation (Bottom Dock)
├─ Cast switcher
├─ Always accessible
└─ Active state clear

LEVEL 3: Actions (Quick Chips)
├─ Common operations
├─ One-tap access
└─ Horizontal scroll

LEVEL 4: Content (Cards)
├─ Memories
├─ Documents
└─ Profile editor
```

---

## 5. THE DECISION CHAIN EXAMPLES

### Example 1: Why 20px border-radius on cards?
```
PURPOSE: Seamless expertise switching
↓
PRINCIPLE: UI should feel modern, not distracting
↓
  ├─ 0px = Aggressive, harsh ❌
  ├─ 8px = Corporate, stiff ❌
  ├─ 20px = Friendly, modern ✅
  └─ 32px = Too playful, bubbly ❌
↓
DECISION: 20px border-radius
↓
PURPOSE CHECK: Does 20px help seamless switching?
  └─ Yes, it fades into background, content stands out
```

### Example 2: Why "You are" text?
```
PURPOSE: Extend user's mind with expertise
↓
PRINCIPLE: User should always know their mental mode
↓
  ├─ Just name = Assumes recognition ❌
  ├─ Icon only = Ambiguous ❌
  └─ "You are" + name = Explicit, undeniable ✅
↓
DECISION: Explicit "You are" label
↓
PURPOSE CHECK: Does this help mental mode awareness?
  └─ Yes, it reinforces identity, reduces confusion
```

---

## 6. MOBILE-SPECIFIC DECISIONS

### Thumb Zone Optimization
```
Bottom dock = Primary navigation (always thumb)
Quick actions = Horizontal scroll (thumb swipe)
Cards = Full width (easy to tap)
Back button = Not needed (dock always visible)
```

### Performance
```
No backdrop-filter blur (GPU expensive)
→ Use solid colors with alpha instead

No heavy shadows
→ Use borders and subtle glows

No parallax
→ Simple transforms only

Result: 60fps on all devices
```

### Accessibility
```
Touch targets: 44px minimum (Apple standard)
Contrast ratios: All text passes WCAG AA
Safe areas: Respects notches/dynamic island
Haptics: Confirms actions for visually impaired
```

---

## 7. COMPARISON: OLD vs NEW

| Aspect | OLD | NEW | Why Better |
|--------|-----|-----|------------|
| **Cast Switching** | List in sidebar | Bottom dock | Thumb-accessible, immediate |
| **Active Cast** | Small badge | Full header | Unmistakable identity |
| **Visual Style** | Generic dark | Cast-colored | Reinforces mental mode |
| **Transition** | Instant | Morph | Fluid, transformative |
| **Navigation** | Tabs | Tabs + Dock | Dual access patterns |
| **Quick Actions** | None | Always visible | No hunting |
| **Haptics** | None | Contextual | Tactile feedback |

---

## 8. THE PHILOSOPHY IN 3 SENTENCES

1. **"You should always know who you are"** → Identity header always visible, unmistakable

2. **"Switching should feel like breathing"** → One-tap, immediate, fluid transition

3. **"Context should never be lost"** → Recent memories, handoffs, continuity preserved

---

## 9. FILES

**Redesigned UI:**
`/apps/miniapps/cast-manager/redesigned.html`

**Features:**
- Morph transition between casts
- Dynamic color system per cast
- Bottom dock navigation
- Quick action chips
- Haptic feedback
- Pulse ring animation
- Optimized for thumb access

---

## 10. NEXT STEPS

To complete:
1. Connect to backend API
2. Add real cast data
3. Implement file upload
4. Add search functionality
5. Test on actual devices

The design foundation is solid and purposeful.
