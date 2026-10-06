# Neubauer Counter

Counts the cells in photos of a Neubauer (improved) hemocytometer on an iPad. For each photo it finds the corner
square (the 4×4 block of 16 small squares), marks the cells inside it and gives the count, the count per small
square, and a session mean with cells/mL.

It is a web app, not an App Store app. It runs in Safari on the iPad, works offline once installed, and nothing
leaves the device: photos are processed locally.

## Put it on the iPad

`index.html` is the whole app (one file). Pick one:

1. **Host the folder on any HTTPS web space** (GitHub Pages, Netlify Drop, a university web server). Open the
   address in Safari on the iPad, tap Share, then **Add to Home Screen**. It then starts like an app and works
   without a connection. Copy `index.html`, `manifest.webmanifest`, `sw.js` and the three `icon-*.png` files.
2. **Open the private claude.ai page** that was published with this project. No hosting needed, but it needs a
   connection and a claude.ai sign-in. The page cannot save files itself, so use **Copy results** there.

Opening `index.html` straight from the Files app does not work reliably in Safari; it needs to be served.

## Using it

1. **Add photos**. One photo per corner square you count. Photos from the camera roll or Files both work.
2. The grid and cells are found in a few seconds. The big number is the cells inside the 4×4 block.
3. **Tap a cell** to remove it. **Tap empty space** to add one. Pinch to zoom, drag to move.
4. **Edit grid** shows four orange corners. Drag them onto the outer grid lines if the detected grid is off.
   **Reset grid** restores the automatic one.
5. **Sensitivity** changes how readily doubtful objects count as cells. **Cells on the grid lines** sets the
   border rule: *Inside* (centre inside the grid), *Top + left* (the standard Neubauer rule) or *All touching*.
6. The Session panel gives the mean per grid and cells/mL = mean × 10 000 × dilution factor (each corner square
   holds 0.1 µL). **Copy results** puts a tab-separated table on the clipboard, **Save CSV** opens the share sheet.

## How well it counts

Checked against the four photos you annotated (70–91 cells each; sensitivity 50):

| Photo | Your count | App | Difference |
|---|---|---|---|
| 1 | 70 | 76 | +9 % |
| 2 | 86 | 82 | −5 % |
| 3 | 75 | 77 | +3 % |
| 4 | 91 | 88 | −3 % |
| All | 322 | 323 | 0 % |

Two cautions. The cell model was tuned on these same four photos (a leave-one-photo-out check gave the same
accuracy, but four photos from one session is a small sample). And the totals look better than the cell-level
agreement: about 85 % of the cells the app marks coincide with a cell you marked, and about 85 % of yours are found.
Misses and extras partly cancel, so review the overlay and fix the few that are wrong.

Your own counts include dim, out-of-focus cells that have a dark outline but no yellow core. The app counts most of
these, but not the ones with a dark centre (concentric rings).

## Limits

- **Sharp, full-resolution photos.** Cell outlines are only 1–2 pixels wide. A slightly blurred photo or one
  downscaled to half size loses many cells (a test with 1.2 px blur found almost none). The app shows a hint when
  it finds very few cells.
- **Exposure** can vary: darker and brighter copies of your photos gave the same counts. Strongly flattened
  contrast lowers the count by 10–30 %.
- **Large debris** (fibres, crystals) can still be picked up as cells in places; remove those by tapping.
- **Clumps.** Touching cells are counted individually when the detector separates them; dense clumps are not
  split reliably.
- The grid search assumes the camera is within about ±3° of square to the grid and that the quadrant is roughly
  in the middle of the field of view. If the grid is not found, the app says so and starts in *Edit grid*.

## Files

- `index.html`: the app, built from `src/`. `artifact.html` is the same app as a page fragment.
- `src/engine.js`: grid and cell detection. `src/app.html`: the interface.
- `build.ps1`: rebuilds `index.html`, `artifact.html`, `manifest.webmanifest`, `sw.js` from `src/` (PowerShell).
- `../dev/`: the test harness used to compare against your annotated screenshots and to fit the cell model
  (`train.js`). It needs a local web server and the original photos; it is not part of the app.
