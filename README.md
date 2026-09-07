# VeriGuard

VeriGuard is a Chrome extension for analyzing online videos for possible deepfake manipulation using an ONNX image-classification model.

## Project layout

- `EXTENSION FILES/` contains the unpacked Chrome extension and bundled ONNX Runtime assets.
- `MODEL CODES/Model_Train.py` contains the training and ONNX export pipeline.

## Load the extension locally

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `EXTENSION FILES` folder.

The extension expects `models/FinalModel.onnx` and uses ImageNet normalization with 224x224 inputs.

## Training

Run `MODEL CODES/Model_Train.py` on the training machine after installing its Python dependencies and updating the dataset paths for that machine. The script exports the trained ONNX model into the configured output directory; copy the final model into `EXTENSION FILES/models/` before loading the extension.
