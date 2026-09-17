# GeoLayer 3D 🌍 
**Team: THE DEBUGGERS | Smart India Hackathon 2026**

> **Live Prototype:** [Click here to view the live 3D Map](https://anurag-26112007.github.io/GeoLayer-SIH-Prototype/)

## 📌 The Problem
**Problem Statement ID:** SIH26011
**Title:** 3D PIN Generation and Vertical Property Mapping System
Traditional 2D municipal maps fail to capture the ownership of stacked units on the same plot. This creates vertical property boundary disputes in dense, multi-story urban infrastructure and makes it difficult to assess vertical and basement taxes.

## 🚀 Our Solution
GeoLayer 3D is a lightweight, web-based geospatial dashboard that visualizes multi-story buildings and assigns a unique 14-digit 3D ULPIN to individual vertical units, permanently demarcating Z-axis ownership. 

* **Browser-Based:** Bypasses the need for heavy desktop GIS software. Works on any standard PC or laptop.
* **Auto-Height Calculation:** Estimates vertical space automatically using standard floor heights (3 meters/floor) to overcome missing height data in older land records.
* **Cost-Effective:** Zero licensing fees and works directly with existing 2D municipal land records.

## 💻 Technical Stack
* **Frontend UI:** HTML5, modern JavaScript, Tailwind CSS
* **3D Mapping Engine:** Mapbox GL JS (for browser-based 3D rendering)
* **Data & Geometry:** GeoJSON and Turf.js 
* **Deployment:** GitHub Pages 

## ⚙️ How to Run Locally
1. Clone this repository to your local machine.
2. Open the project folder in VS Code.
3. Use the "Live Server" extension to open `index.html`.
4. Ensure you have an active internet connection to load the Mapbox map tiles and Tailwind CSS CDN.

---
*Built with ❤️ for Digital India Land Records Modernization Programme (DILRMP)*
