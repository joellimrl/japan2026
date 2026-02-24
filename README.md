# Lucky Draw Static Web Page

A simple web-based lucky draw application for conducting random prize drawings.

## Demo

🎯 **Live Demo**: [https://joellimrl.github.io/luckyDraw/](https://joellimrl.github.io/luckyDraw/)

![Lucky Draw Screenshot](screenshot.png)

## Features

- Upload participant lists via CSV file
- Random winner selection with visual cycling animation
- Prize management with images and descriptions
- Winner tracking and download functionality
- Customizable background and prize images

## Setup

Before using the application, configure the following:

### 1. Prize Images
- Add prize images to the `images/` folder
- Supported formats: JPG, PNG, GIF

### 2. Configure Prizes
Edit `common.js` and update these arrays:
- `allImages`: Array of image filenames (must match files in images folder)
- `allPrizeText`: Array of prize descriptions

**Important:** Both arrays must have the same length and corresponding order.

### 3. Background Image (Optional)
- Replace `background.jpg` with your custom background image
- Image will be used as the page background

## How to Use

### Step 1: Prepare Participants
1. Create a CSV file with participant names (see `sample.csv` for format)
2. Upload the CSV file using the file upload button

### Step 2: Conduct Lucky Draw
1. Click **Draw Winner** to start the selection process
2. Watch as names cycle through before selecting a random winner
3. The winner appears in the right panel with their prize
4. Click **Next** to proceed to the next prize draw

### Step 3: Manage Results
- Use **Download winners** to save results as `output.json`
- The JSON file can be re-uploaded to restore previous winner data

## Important Notes

- ⚠️ **Refresh Warning**: Refreshing the page will clear all current winners. Always download results first!
- Winners are automatically removed from the participant pool after selection

## File Structure

```
luckyDraw/
├── index.html          # Main application page
├── common.js           # Configuration and logic
├── sample.csv          # Example participant list format
├── background.jpg      # Background image (optional)
├── images/            # Prize images folder
└── README.md          # This file
```

## CSV Format

Your participant CSV should have one name per line:
```
John Doe
Jane Smith
Bob Johnson
```
