import os
import gc
import csv
import time
import math
import random
import copy
from contextlib import nullcontext
import numpy as np
import pandas as pd
import cv2
import matplotlib
matplotlib.use('Agg')  
import matplotlib.pyplot as plt
import seaborn as sns
from PIL import Image
from tqdm import tqdm
from collections import defaultdict
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler
import torchvision.transforms as transforms

try:
    from torch.amp import autocast, GradScaler
except ImportError:
    from torch.cuda.amp import autocast, GradScaler
import timm
from facenet_pytorch import MTCNN
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score,
    f1_score, roc_auc_score, roc_curve, auc,
    confusion_matrix, classification_report
)


def seed_everything(seed=42):
    random.seed(seed)
    os.environ['PYTHONHASHSEED'] = str(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
seed_everything(42)
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"Execution Device: {device}")
if torch.cuda.is_available():
    print(f"Active GPU(s): {torch.cuda.device_count()}")
    for i in range(torch.cuda.device_count()):
        print(f"  GPU {i}: {torch.cuda.get_device_name(i)}")
def get_autocast_context(device):
    if device.type == 'cuda':
        try:
            return autocast(device_type='cuda')
        except TypeError:
            return autocast()
    return nullcontext()


celeb_base      = r'C:\Users\HP\Downloads\Deepfake_Project\Dataset\Celeb Dataset\Celeb-DF'
face_base       = r'C:\Users\HP\Downloads\Deepfake_Project\Dataset\face++dataset'


celeb_real_path = os.path.join(celeb_base, 'Celeb-real')
celeb_yt_path   = os.path.join(celeb_base, 'YouTube-real')
celeb_fake_path = os.path.join(celeb_base, 'Celeb-synthesis')
celeb_test_file = os.path.join(celeb_base, 'List_of_testing_videos.txt')

face_real_path  = os.path.join(face_base, 'ffpp_real')
face_fake_path  = os.path.join(face_base, 'ffpp_fake')


output_base      = r'C:\Users\HP\Downloads\Deepfake_Project\Output'
frames_dir       = os.path.join(output_base, 'Frames')
models_save_path = os.path.join(output_base, 'Saved_Models')
manifest_dir     = os.path.join(output_base, 'Manifests')
results_dir      = os.path.join(output_base, 'Results')


for folder in [frames_dir, models_save_path, manifest_dir, results_dir]:
    os.makedirs(folder, exist_ok=True)


all_paths_ok = True
for name, path in {
    'Celeb-real': celeb_real_path,
    'YouTube-real': celeb_yt_path,
    'Celeb-synthesis': celeb_fake_path,
    'Test list': celeb_test_file,
    'FF++ real': face_real_path,
    'FF++ fake': face_fake_path
}.items():
    exists = os.path.exists(path)
    print(f"Path verification - {name}: {'OK' if exists else 'MISSING'}")
    if not exists:
        all_paths_ok = False

if not all_paths_ok:
    print("\nWARNING: Some input data directories are missing. Check your local file paths.")


celeb_official_test = set()
if os.path.exists(celeb_test_file):
    with open(celeb_test_file, 'r') as f:
        raw_lines = f.read().splitlines()
    for line in raw_lines:
        parts = line.strip().split()
        if parts:
            celeb_official_test.add(os.path.basename(parts[-1]))

video_registry = []

def register_celeb_videos(dir_path, dataset_name, label):
    if not os.path.exists(dir_path):
        return
    videos = [f for f in os.listdir(dir_path) if f.endswith(('.mp4', '.avi', '.mov'))]
    for vid in videos:
        split = 'test' if vid in celeb_official_test else 'trainval'
        video_registry.append({
            'video_id': f"{dataset_name}_{label}_{vid}",
            'source_path': os.path.join(dir_path, vid),
            'label': label,
            'split': split,
            'dataset': dataset_name
        })

register_celeb_videos(celeb_real_path, 'celebdf_real', 0)
register_celeb_videos(celeb_yt_path, 'celebdf_yt', 0)
register_celeb_videos(celeb_fake_path, 'celebdf_fake', 1)

ff_real = [f for f in os.listdir(face_real_path) if f.endswith(('.mp4', '.avi', '.mov'))] if os.path.exists(face_real_path) else []
ff_fake = [f for f in os.listdir(face_fake_path) if f.endswith(('.mp4', '.avi', '.mov'))] if os.path.exists(face_fake_path) else []

def split_and_register_ffpp(video_list, src_dir, label):
    if not video_list:
        return
    random.seed(42)
    shuffled = list(video_list)
    random.shuffle(shuffled)
    n = len(shuffled)
    
    train_cut = int(0.70 * n)
    val_cut = int(0.80 * n)
    
    for idx, vid in enumerate(shuffled):
        if idx < train_cut:
            split = 'train'
        elif idx < val_cut:
            split = 'val'
        else:
            split = 'test'
            
        video_registry.append({
            'video_id': f"ffpp_{label}_{vid}",
            'source_path': os.path.join(src_dir, vid),
            'label': label,
            'split': split,
            'dataset': 'ffpp'
        })

split_and_register_ffpp(ff_real, face_real_path, 0)
split_and_register_ffpp(ff_fake, face_fake_path, 1)

trainval_videos = [v for v in video_registry if v['split'] == 'trainval']
if trainval_videos:
    random.seed(42)
    random.shuffle(trainval_videos)
    train_cut = int(0.80 * len(trainval_videos))
    for idx, v in enumerate(trainval_videos):
        v['split'] = 'train' if idx < train_cut else 'val'

train_vids = [v for v in video_registry if v['split'] == 'train']
val_vids   = [v for v in video_registry if v['split'] == 'val']
test_vids  = [v for v in video_registry if v['split'] == 'test']

print(f"\n--- Video Set Split Counts ---")
print(f"Train Videos: {len(train_vids)} (Real: {sum(1 for v in train_vids if v['label'] == 0)}, Fake: {sum(1 for v in train_vids if v['label'] == 1)})")
print(f"Val Videos  : {len(val_vids)} (Real: {sum(1 for v in val_vids if v['label'] == 0)}, Fake: {sum(1 for v in val_vids if v['label'] == 1)})")
print(f"Test Videos : {len(test_vids)} (Real: {sum(1 for v in test_vids if v['label'] == 0)}, Fake: {sum(1 for v in test_vids if v['label'] == 1)})")


def extract_face_crops_pipeline(video_list, split_name, frame_skip=10):
    if not video_list:
        print(f"Skipping {split_name} extraction - no input videos registered.")
        return []
    
    split_dir = os.path.join(frames_dir, split_name)
    os.makedirs(split_dir, exist_ok=True)
    
    records = []
    manifest_path = os.path.join(manifest_dir, f"{split_name}_manifest.csv")
    
    completed_videos = set()
    if os.path.exists(manifest_path):
        try:
            df_manifest = pd.read_csv(manifest_path)
            completed_videos = set(df_manifest['video_id'].unique())
            records = df_manifest.to_dict('records')
            print(f"Resuming {split_name} extraction. {len(completed_videos)} videos already completed.")
        except Exception as e:
            print(f"Failed to read existing manifest, generating fresh: {e}")
            
    mtcnn = MTCNN(
        image_size=224,
        margin=20,
        keep_all=False,
        select_largest=True,
        post_process=False,
        device=device
    )
    
    for v_info in tqdm(video_list, desc=f"Extracting {split_name} face crops"):
        video_id = v_info['video_id']
        src_path = v_info['source_path']
        
        corrected_label = v_info['label']  
        
        if video_id in completed_videos:
            continue
            
        safe_id = video_id.replace('/', '_').replace(' ', '_')
        cap = cv2.VideoCapture(src_path)
        if not cap.isOpened():
            continue
            
        frame_idx = 0
        success, frame = cap.read()
        
        while success:
            if frame_idx % frame_skip == 0:
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                pil_img = Image.fromarray(frame_rgb)
                
                save_path = os.path.join(split_dir, f"{safe_id}_f{frame_idx}.jpg")
                
                try:
                    face_crop = mtcnn(pil_img, save_path=save_path)
                    
                    if face_crop is not None:
                        records.append({
                            'frame_path': save_path,
                            'label': corrected_label,  
                            'video_id': video_id,
                            'split': split_name
                        })
                    else:
                        fallback = pil_img.resize((224, 224), Image.Resampling.LANCZOS)
                        fallback.save(save_path)
                        
                        records.append({
                            'frame_path': save_path,
                            'label': corrected_label,  
                            'video_id': video_id,
                            'split': split_name
                        })
                except Exception:
                    pass  
                    
            success, frame = cap.read()
            frame_idx += 1
            
        cap.release()
        completed_videos.add(video_id)
        

    del mtcnn
    gc.collect()
    torch.cuda.empty_cache()
    
    if records:
        df_records = pd.DataFrame(records)
        df_records.to_csv(manifest_path, index=False)
        print(f"Manifest saved to {manifest_path} ({len(records)} rows with corrected labels)")
        
    return records

print("\n--- Extracting Train Crops ---")
train_records = extract_face_crops_pipeline(train_vids, 'train')

print("\n--- Extracting Validation Crops ---")
val_records   = extract_face_crops_pipeline(val_vids, 'val')

print("\n--- Extracting Test Crops ---")
test_records  = extract_face_crops_pipeline(test_vids, 'test')

train_csv = os.path.join(manifest_dir, 'train_manifest.csv')
val_csv   = os.path.join(manifest_dir, 'val_manifest.csv')
test_csv  = os.path.join(manifest_dir, 'test_manifest.csv')

class DeepfakeDataset(Dataset):
    def __init__(self, csv_path, transform=None):
        self.df = pd.read_csv(csv_path)
        self.transform = transform
        self.labels = self.df['label'].values
        
    def __len__(self):
        return len(self.df)
        
    def __getitem__(self, idx):
        row = self.df.iloc[idx]
        img_path = row['frame_path']
        label = row['label']
        video_id = row['video_id']
        
        img = Image.open(img_path).convert('RGB')
        
        if self.transform:
            img = self.transform(img)
            
        return img, torch.tensor([label], dtype=torch.float32), video_id
def collate_fn(batch):
    imgs = torch.stack([item[0] for item in batch])
    labels = torch.stack([item[1] for item in batch])
    video_ids = [item[2] for item in batch]
    return imgs, labels, video_ids
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD  = [0.229, 0.224, 0.225]
train_transforms = transforms.Compose([
    transforms.RandomHorizontalFlip(p=0.5),
    transforms.RandomRotation(degrees=10),
    transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.2),
    transforms.ToTensor(),
    transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD)
])
val_test_transforms = transforms.Compose([
    transforms.ToTensor(),
    transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD)
])
def make_dataloader(csv_path, transform, batch_size, is_train=False):
    if not os.path.exists(csv_path) or os.path.getsize(csv_path) < 10:
        return None, None
        
    dataset = DeepfakeDataset(csv_path, transform=transform)
    
    if is_train:
        labels = dataset.labels
        class_counts = np.bincount(labels)
        class_counts = np.maximum(class_counts, 1)  
        class_weights = 1.0 / class_counts
        sample_weights = torch.tensor([class_weights[l] for l in labels], dtype=torch.float)
        
        sampler = WeightedRandomSampler(
            weights=sample_weights,
            num_samples=len(sample_weights),
            replacement=True
        )
        
        loader = DataLoader(
            dataset,
            batch_size=batch_size,
            sampler=sampler,
            num_workers=0,
            collate_fn=collate_fn,
            pin_memory=True if torch.cuda.is_available() else False
        )
    else:
        loader = DataLoader(
            dataset,
            batch_size=batch_size,
            shuffle=False,
            num_workers=0,
            collate_fn=collate_fn,
            pin_memory=True if torch.cuda.is_available() else False
        )
    return loader, dataset
BATCH_SIZE = 64  
train_loader, train_dataset = make_dataloader(train_csv, train_transforms, BATCH_SIZE, is_train=True)
val_loader, val_dataset     = make_dataloader(val_csv, val_test_transforms, BATCH_SIZE, is_train=False)
test_loader, test_dataset   = make_dataloader(test_csv, val_test_transforms, BATCH_SIZE, is_train=False)


class WarmupCosineScheduler:
    def __init__(self, optimizer, warmup_epochs, total_epochs, base_lr=1e-6, target_lr=1e-4):
        self.optimizer = optimizer
        self.warmup_epochs = warmup_epochs
        self.total_epochs = total_epochs
        self.base_lr = base_lr
        self.target_lr = target_lr
        self.current_epoch = 0
        
    def step(self):
        self.current_epoch += 1
        
        if self.current_epoch <= self.warmup_epochs:
            progress = self.current_epoch / self.warmup_epochs
            lr = self.base_lr + progress * (self.target_lr - self.base_lr)
        else:
            denom = max(1, self.total_epochs - self.warmup_epochs)
            progress = min(1.0, (self.current_epoch - self.warmup_epochs) / denom)
            lr = self.target_lr * 0.5 * (1 + math.cos(math.pi * progress))
            
        for param_group in self.optimizer.param_groups:
            param_group['lr'] = lr
        return lr
        
    def get_lr(self):
        return self.optimizer.param_groups[0]['lr']


def get_clean_state_dict(model):
    """Returns underlying model weights, stripping DataParallel wrapper if present."""
    if isinstance(model, nn.DataParallel):
        return model.module.state_dict()
    return model.state_dict()

def train_model(model, model_name, train_loader, val_loader, num_epochs=20, target_lr=1e-4, warmup_epochs=3, patience=4):
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    
    if torch.cuda.device_count() > 1:
        print(f"Wrapping model in DataParallel. Active GPUs: {torch.cuda.device_count()}")
        model = nn.DataParallel(model)
    model = model.to(device)
    
    optimizer = optim.AdamW(model.parameters(), lr=1e-6, weight_decay=1e-4)
    scheduler = WarmupCosineScheduler(optimizer, warmup_epochs, num_epochs, base_lr=1e-6, target_lr=target_lr)
    criterion = nn.BCEWithLogitsLoss()
    
    scaler = GradScaler() if device.type == 'cuda' else None
    
    best_val_auc = 0.0
    best_epoch = 0
    stop_counter = 0
    
    train_losses, train_accs = [], []
    val_losses, val_accs = [], []
    
    best_model_path = os.path.join(models_save_path, f"{model_name}_best.pth")
    
    for epoch in range(num_epochs):
        current_lr = scheduler.get_lr()
        print(f"\n{model_name} | Epoch {epoch+1}/{num_epochs} | lr={current_lr:.2e}")
        
        model.train()
        running_loss = 0.0
        correct = 0
        total = 0
        
        for batch_idx, (imgs, labels, _) in enumerate(train_loader):
            imgs = imgs.to(device, non_blocking=True)
            labels = labels.to(device, non_blocking=True)
            
            optimizer.zero_grad()
            
            if scaler:
                with get_autocast_context(device):
                    outputs = model(imgs)
                    loss = criterion(outputs, labels)
                scaler.scale(loss).backward()
                scaler.step(optimizer)
                scaler.update()
            else:
                outputs = model(imgs)
                loss = criterion(outputs, labels)
                loss.backward()
                optimizer.step()
                
            running_loss += loss.item()
            preds = (torch.sigmoid(outputs) > 0.5).float()
            correct += (preds == labels).sum().item()
            total += labels.size(0)
            
        scheduler.step()
        
        epoch_train_loss = running_loss / len(train_loader)
        epoch_train_acc = correct / total
        train_losses.append(epoch_train_loss)
        train_accs.append(epoch_train_acc)
        
        model.eval()
        val_loss = 0.0
        val_correct = 0
        val_total = 0
        val_probs = []
        val_labels = []
        
        with torch.no_grad():
            for val_imgs, val_lbls, _ in val_loader:
                val_imgs = val_imgs.to(device, non_blocking=True)
                val_lbls = val_lbls.to(device, non_blocking=True)
                
                if scaler:
                    with get_autocast_context(device):
                        val_outputs = model(val_imgs)
                        v_loss = criterion(val_outputs, val_lbls)
                else:
                    val_outputs = model(val_imgs)
                    v_loss = criterion(val_outputs, val_lbls)
                    
                val_loss += v_loss.item()
                probs = torch.sigmoid(val_outputs)
                preds = (probs > 0.5).float()
                
                val_correct += (preds == val_lbls).sum().item()
                val_total += val_lbls.size(0)
                
                val_probs.extend(probs.cpu().numpy().flatten())
                val_labels.extend(val_lbls.cpu().numpy().flatten())
                
        epoch_val_loss = val_loss / len(val_loader)
        epoch_val_acc = val_correct / val_total
        epoch_val_auc = roc_auc_score(val_labels, val_probs)
        
        val_losses.append(epoch_val_loss)
        val_accs.append(epoch_val_acc)
        
        print(f"Train Loss: {epoch_train_loss:.4f} | Train Acc: {epoch_train_acc:.4f}")
        print(f"Val Loss  : {epoch_val_loss:.4f} | Val Acc  : {epoch_val_acc:.4f} | Val AUC: {epoch_val_auc:.4f}")
        
        if epoch_val_auc > best_val_auc:
            best_val_auc = epoch_val_auc
            best_epoch = epoch + 1
            stop_counter = 0
            
            clean_state = get_clean_state_dict(model)
            torch.save(clean_state, best_model_path)
            print(f"Saved new best model checkpoint! (AUC: {best_val_auc:.4f})")
        else:
            stop_counter += 1
            print(f"No improvement. Early stopping counter: {stop_counter}/{patience}")
            if stop_counter >= patience:
                print(f"Early stopping triggered. Selected Best Epoch {best_epoch} with AUC {best_val_auc:.4f}")
                break
                
    return model, train_losses, train_accs, val_losses, val_accs, best_val_auc

def evaluate_video_level(model, model_name, test_loader, threshold, results_csv):
    model.eval()
    
    video_probs = defaultdict(list)
    video_labels = {}
    gpu_times = []
    
    device = next(model.parameters()).device
    
    with torch.no_grad():
        for imgs, labels, video_ids in test_loader:
            imgs = imgs.to(device, non_blocking=True)
            
            start = time.time()
            if device.type == 'cuda':
                with get_autocast_context(device):
                    outputs = model(imgs)
                torch.cuda.synchronize()
            else:
                outputs = model(imgs)
            end = time.time()
            gpu_times.append(end - start)
            
            probs = torch.sigmoid(outputs).cpu().numpy().flatten()
            lbls = labels.numpy().flatten()
            
            for vid_id, prob, lbl in zip(video_ids, probs, lbls):
                video_probs[vid_id].append(prob)
                video_labels[vid_id] = lbl
                
    avg_gpu_ms = (sum(gpu_times) / len(gpu_times)) * 1000 if gpu_times else 0.0
    
    raw_model = model.module if isinstance(model, nn.DataParallel) else model
    cpu_model = copy.deepcopy(raw_model).to('cpu')
    cpu_times = []
    
    with torch.no_grad():
        for batch_idx, (imgs, _, _) in enumerate(test_loader):
            if batch_idx >= 3:
                break
            start = time.time()
            cpu_model(imgs)
            end = time.time()
            cpu_times.append(end - start)
            
    avg_cpu_ms = (sum(cpu_times) / len(cpu_times)) * 1000 if cpu_times else 0.0
    
    del cpu_model
    gc.collect()
    
    all_video_ids = list(video_probs.keys())
    if not all_video_ids:
        print(f"[{model_name}] No test samples processed for video-level evaluation.")
        return {}
    all_video_probs = np.array([np.mean(video_probs[v]) for v in all_video_ids])
    all_video_labels = np.array([video_labels[v] for v in all_video_ids])
    all_video_preds = (all_video_probs > threshold).astype(int)
    
    acc = accuracy_score(all_video_labels, all_video_preds)
    precision = precision_score(all_video_labels, all_video_preds, zero_division=0)
    recall = recall_score(all_video_labels, all_video_preds, zero_division=0)
    f1 = f1_score(all_video_labels, all_video_preds, zero_division=0)
    
    unique_labels = np.unique(all_video_labels)
    if len(unique_labels) > 1:
        auc_score = roc_auc_score(all_video_labels, all_video_probs)
        has_auc = True
    else:
        auc_score = 0.0
        has_auc = False
        print(f"[{model_name}] Warning: Test set only contains one class. AUC-ROC is set to 0.")
    
    print(f"\n{'='*55}")
    print(f" {model_name} - VIDEO-LEVEL METRICS SUMMARY")
    print(f"{'='*55}")
    print(f"Total Videos   : {len(all_video_ids)}")
    print(f"AUC Score      : {auc_score:.4f}")
    print(f"Accuracy       : {acc:.4f}")
    print(f"Precision      : {precision:.4f}")
    print(f"Recall         : {recall:.4f}")
    print(f"F1 Score       : {f1:.4f}")
    print(f"GPU ms/batch   : {avg_gpu_ms:.2f} ms")
    print(f"CPU ms/batch   : {avg_cpu_ms:.2f} ms")
    
    print("\nClassification Report:")
    print(classification_report(all_video_labels, all_video_preds, target_names=["Real", "Fake"], zero_division=0))


    
    cm = confusion_matrix(all_video_labels, all_video_preds, labels=[0, 1])
    plt.figure(figsize=(5, 4))
    sns.heatmap(cm, annot=True, fmt="d", cmap="Blues", xticklabels=["Real", "Fake"], yticklabels=["Real", "Fake"])
    plt.xlabel("Predicted Label")
    plt.ylabel("Actual Label")
    plt.title(f"{model_name} - Video Level Confusion Matrix")
    plt.tight_layout()
    plt.savefig(os.path.join(results_dir, f'{model_name}_confusion_matrix.png'))
    plt.close()
    
    if has_auc:
        fpr, tpr, _ = roc_curve(all_video_labels, all_video_probs)
        plt.figure(figsize=(5, 4))
        plt.plot(fpr, tpr, color='darkorange', lw=2, label=f'AUC = {auc_score:.4f}')
        plt.plot([0, 1], [0, 1], color='navy', linestyle='--')
        plt.xlabel('False Positive Rate')
        plt.ylabel('True Positive Rate')
        plt.title(f'{model_name} - Video Level ROC')
        plt.legend(loc="lower right")
        plt.tight_layout()
        plt.savefig(os.path.join(results_dir, f'{model_name}_roc_curve.png'))
        plt.close()
    
    file_exists = os.path.exists(results_csv)
    with open(results_csv, 'a', newline='') as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow([
                'model', 'accuracy', 'precision', 'recall',
                'f1', 'auc', 'gpu_ms_per_batch', 'cpu_ms_per_batch',
                'videos_evaluated'
            ])
        writer.writerow([
            model_name, acc, precision, recall, f1, auc_score,
            avg_gpu_ms, avg_cpu_ms, len(all_video_ids)
        ])
        
    return {
        'model': model_name, 'accuracy': acc, 'precision': precision,
        'recall': recall, 'f1': f1, 'auc': auc_score
    }

def create_xception_model(pretrained=True, num_classes=1):
    try:
        return timm.create_model('xception', pretrained=pretrained, num_classes=num_classes)
    except RuntimeError:
        return timm.create_model('legacy_xception', pretrained=pretrained, num_classes=num_classes)

results_csv = os.path.join(results_dir, 'benchmark_results.csv')
if os.path.exists(results_csv):
    os.remove(results_csv)

best_threshold = 0.50

model_configs = {
    'EfficientNetB0': {
        'builder': lambda: timm.create_model('efficientnet_b0', pretrained=True, num_classes=1),
        'epochs': 15,
        'target_lr': 1e-4,
        'warmup_epochs': 3,
        'patience': 4
    }
}

all_results = {}
for model_name, config in model_configs.items():
    if train_loader is None or val_loader is None:
        print(f"Skipping training for {model_name} due to missing dataset manifests.")
        continue
        
    print(f"\n{'='*60}")
    print(f"INITIALIZING PIPELINE: {model_name}")
    print(f"{'='*60}")
    
    model = config['builder']()
    
    model, train_losses, train_accs, val_losses, val_accs, best_auc = train_model(
        model=model,
        model_name=model_name,
        train_loader=train_loader,
        val_loader=val_loader,
        num_epochs=config['epochs'],
        target_lr=config['target_lr'],\
        warmup_epochs=config['warmup_epochs'],
        patience=config['patience']
    )
    
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 8))
    ax1.plot(train_losses, label='Train Loss', color='royalblue')
    ax1.plot(val_losses, label='Val Loss', color='crimson')
    ax1.set_title(f'{model_name} - Loss curves')
    ax1.set_xlabel('Epoch')
    ax1.legend()
    
    ax2.plot(train_accs, label='Train Acc', color='royalblue')
    ax2.plot(val_accs, label='Val Acc', color='crimson')
    ax2.set_title(f'{model_name} - Accuracy curves')
    ax2.set_xlabel('Epoch')
    ax2.legend()
    plt.tight_layout()
    plt.savefig(os.path.join(results_dir, f'{model_name}_loss_acc_curves.png'))
    plt.close()
    
    best_weights_path = os.path.join(models_save_path, f"{model_name}_best.pth")
    eval_model = config['builder']()
    eval_model.load_state_dict(
        torch.load(best_weights_path, map_location='cpu', weights_only=True)
    )
    
    if torch.cuda.device_count() > 1:
        eval_model = nn.DataParallel(eval_model)
    eval_model = eval_model.to(device)
    
    result = evaluate_video_level(eval_model, model_name, test_loader, best_threshold, results_csv)
    all_results[model_name] = result
    
    del model
    del eval_model
    gc.collect()
    torch.cuda.empty_cache()
    print(f"Memory freed. GPU Cache cleared after {model_name}.\n")

best_name = None
if os.path.exists(results_csv):
    results_df = pd.read_csv(results_csv)
    print("\n" + "=" * 80)
    print("                      FINAL DEEPFAKE BENCHMARK TABLE")
    print("=" * 80)
    print(results_df.to_string(index=False))
    print("=" * 80)
    
    best_row = results_df.loc[results_df['auc'].idxmax()]
    best_name = best_row['model']
    print(f"\nWinner Model: {best_name}")
    print(f"  AUC Score: {best_row['auc']:.4f}")
    print(f"  F1 Score : {best_row['f1']:.4f}")
    print(f"  Accuracy : {best_row['accuracy']:.4f}")
    
    metrics = ['accuracy', 'precision', 'recall', 'f1', 'auc']
    x = np.arange(len(results_df['model']))
    width = 0.15
    fig, ax = plt.subplots(figsize=(10, 5))
    
    for idx, metric in enumerate(metrics):
        ax.bar(x + idx * width, results_df[metric], width, label=metric)
        
    ax.set_xticks(x + width * 2)
    ax.set_xticklabels(results_df['model'].tolist())
    ax.set_ylabel('Scores')
    ax.set_title('EfficientNetB0 Performance Benchmark')
    ax.legend(loc='lower left')
    plt.tight_layout()
    plt.savefig(os.path.join(results_dir, 'benchmark_comparison.png'))
    plt.close()
else:
    print("\nBenchmark results database missing. Check training pipeline executions.")


import json

if best_name:
    print(f"\nExporting best model '{best_name}' to ONNX format...")
    
    if best_name == 'EfficientNetB0':
        best_model = timm.create_model('efficientnet_b0', pretrained=False, num_classes=1)
    else:
        best_model = create_xception_model(pretrained=False, num_classes=1)
        
    best_weights_path = os.path.join(models_save_path, f"{best_name}_best.pth")
    best_model.load_state_dict(
        torch.load(best_weights_path, map_location='cpu', weights_only=True)
    )
    
    best_model = nn.Sequential(
        best_model,
        nn.Sigmoid()
    )
    
    best_model = best_model.to(device)
    best_model.eval()
    
    dummy_input = torch.randn(1, 3, 224, 224).to(device)
    onnx_path = os.path.join(models_save_path, 'FinalModel.onnx')
    
    torch.onnx.export(
        best_model,
        dummy_input,
        onnx_path,
        export_params=True,
        opset_version=14,
        do_constant_folding=True,
        input_names=['input.1'],
        output_names=['output'],
        dynamic_axes={
            'input.1': {0: 'batch_size'},  
            'output': {0: 'batch_size'}
        }
    )
    print(f"Export Complete! File saved: {onnx_path}")

    inference_config = {
        'model_name'      : best_name,
        'threshold'       : float(best_threshold),
        'img_size'        : 224,
        'imagenet_mean'   : [0.485, 0.456, 0.406],
        'imagenet_std'    : [0.229, 0.224, 0.225],
        'label_convention': 'fake=1 real=0',
        'input_node'      : 'input.1',
        'note'            : 'output > threshold means DEEPFAKE DETECTED (Sigmoid is now built-in)'
    }

    config_path = os.path.join(models_save_path, 'inference_config.json')
    with open(config_path, 'w') as f:
        json.dump(inference_config, f, indent=2)

    print(f"Inference config saved to: {config_path}")
    print(json.dumps(inference_config, indent=2))
    
    try:
        import onnxruntime as ort
        session = ort.InferenceSession(onnx_path)
        
        test_in = np.random.randn(2, 3, 224, 224).astype(np.float32)
        out = session.run(None, {'input.1': test_in})
        print(f"ONNX Model validation verified. Output Tensor Shape: {out[0].shape}")
    except Exception as e:
        print(f"ONNX runtime verification failed: {e}")