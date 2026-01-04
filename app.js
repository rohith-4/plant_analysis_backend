import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const fsPromises = fs.promises;
const app = express();
const port = process.env.PORT || 5000;

// Fix __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer to keep files in memory so we can store them in GridFS
const upload = multer({ storage: multer.memoryStorage() });

// MongoDB / GridFS
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/plant_analysis";
let bucket;
mongoose.set("strictQuery", false);
mongoose.connect(mongoUri)
  .then(() => {
    const db = mongoose.connection.db;
    bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: "uploads" });
    console.log("Connected to MongoDB and GridFS bucket ready");
    // Start server only after DB connected
    app.listen(port, () => {
      console.log(`Listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);


// Analyze Image Route
// - stores the uploaded image into GridFS and runs the model

app.post("/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded" });
    }

    if (!bucket) {
      return res.status(500).json({ error: "Storage not initialized" });
    }

    const buffer = req.file.buffer;
    const base64Data = buffer.toString("base64");

    // Save original image to GridFS
    const uploadStream = bucket.openUploadStream(req.file.originalname, {
      contentType: req.file.mimetype,
    });
    uploadStream.end(buffer);

    await new Promise((resolve, reject) => {
      uploadStream.on("finish", resolve);
      uploadStream.on("error", reject);
    });
  const imageFileId = uploadStream.id;
    
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const result = await model.generateContent([
      "Analyze this plant image and provide detailed analysis of its species, health, characteristics, care instructions, and interesting facts. Provide plain text only.",
      {
        inlineData: {
          mimeType: req.file.mimetype,
          data: base64Data,
        },
      },
    ]);

    const plantInfo = result.response.text();
    if (!imageFileId) {
      throw new Error("Image failed to store in GridFS");
    }
    res.json({
      result: plantInfo,
      image: `data:${req.file.mimetype};base64,${base64Data}`,
      imageFileId: uploadStream.id,
    });
  } catch (error) {
    console.error("Error analyzing image:", error);
    res.status(500).json({
      error: "An error occurred while analyzing the image",
    });
  }
});


// Download PDF Route

// POST /download
// - Generates a PDF from supplied `result` and optional `image` (data URL)
// - Stores the PDF in GridFS and returns its file id for later download
app.post("/download", async (req, res) => {
  try {
    const { result, image } = req.body;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=Plant_Report.pdf");

    const doc = new PDFDocument();
    doc.pipe(res);

    doc.fontSize(22).text("Plant Analysis Report", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(result || "");

    if (image) {
      const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      doc.addPage();
      doc.image(buffer, { fit: [500, 300], align: "center" });
    }

    doc.end();
  } catch (err) {
    console.error("PDF generation error:", err);
    res.status(500).json({ error: "PDF generation failed" });
  }
});



// GET /download/:id
// - Streams a stored file (PDF or image) to the client

app.get("/test-pdf", (req, res) => {
  const doc = new PDFDocument();
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);

  doc.fontSize(20).text("PDF TEST – NO IMAGE");
  doc.end();
});



// NOTE: server is started after MongoDB connects above
