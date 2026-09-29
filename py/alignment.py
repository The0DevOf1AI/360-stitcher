"""Refine DJI camera rotations and focal length from robust visual correspondences."""
import math
import numpy as np
import cv2
from PIL import Image, ImageOps
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation
from scipy.sparse import lil_matrix


def basis(yaw, pitch):
    cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
    return np.array([[cy, sp*sy, cp*sy], [-sy, sp*cy, cp*cy], [0, -cp, sp]])


def align(files, rows, progress):
    cv2.setNumThreads(4)
    features, rotations, aspects = [], [], []
    sift = cv2.SIFT_create(nfeatures=5000)
    for i, path in enumerate(files):
        row = rows[path.name.lower()]
        rotations.append(basis(math.radians(float(row['GimbalYawDegree'])), math.radians(float(row['GimbalPitchDegree']))))
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert('RGB')
            image.thumbnail((1400, 1400))
            frame = np.asarray(image)
        h,w = frame.shape[:2]
        aspects.append(h/w)
        kp, desc = sift.detectAndCompute(cv2.cvtColor(frame,cv2.COLOR_RGB2GRAY),None)
        pts = np.array([k.pt for k in kp],np.float32)
        features.append((pts,desc,w,h))
        progress(f'Finding detail {i+1}/{len(files)}: {path.name}')
    links=[]
    matcher=cv2.BFMatcher()
    for i in range(len(files)):
        progress(f'Matching detail {i+1}/{len(files)}: {files[i].name}')
        for j in range(i+1,len(files)):
            if rotations[i][:,2] @ rotations[j][:,2] < 0.0:
                continue
            pi,di,wi,hi=features[i]; pj,dj,wj,hj=features[j]
            if di is None or dj is None or len(dj)<2: continue
            pairs=matcher.knnMatch(di,dj,k=2)
            good=[a for pair in pairs if len(pair)==2 for a,b in [pair] if a.distance<0.72*b.distance]
            if len(good)<16: continue
            ai=np.array([pi[m.queryIdx] for m in good]); aj=np.array([pj[m.trainIdx] for m in good])
            _, mask=cv2.findHomography(ai,aj,cv2.RANSAC,2.5)
            if mask is None or mask.sum()<16: continue
            ai=ai[mask.ravel()>0]; aj=aj[mask.ravel()>0]
            # Retain spatially distributed matches, not just a dense central patch.
            indices=np.linspace(0,len(ai)-1,min(120,len(ai))).astype(int)
            ai=(ai[indices]-[wi/2,hi/2])/wi
            aj=(aj[indices]-[wj/2,hj/2])/wj
            links.append((i,j,ai,aj))
    if not links: raise RuntimeError('Could not find reliable overlapping detail for alignment.')
    connected={0}
    for _ in files:
        for i,j,_,_ in links:
            if i in connected or j in connected: connected.update([i,j])
    if len(connected)!=len(files):
        missing=', '.join(p.name for k,p in enumerate(files) if k not in connected)
        raise RuntimeError('Unconnected photos cannot be aligned reliably: '+missing)
    n=len(files)
    base=np.asarray(rotations)
    focal0=24/43.2666*math.sqrt(1+aspects[0]**2)
    total=sum(len(a)*3 for _,_,a,_ in links)
    pattern=lil_matrix((total+n*3+1,n*3+1),dtype=int)
    start=0
    for i,j,a,b in links:
        end=start+len(a)*3
        pattern[start:end,3*i:3*i+3]=1; pattern[start:end,3*j:3*j+3]=1; pattern[start:end,-1]=1
        start=end
    for k in range(n*3):pattern[total+k,k]=1
    pattern[-1,-1]=1
    def residual(params, regularize=True):
        mats=Rotation.from_rotvec(params[:-1].reshape(n,3)).as_matrix() @ base
        focal=focal0*math.exp(params[-1])
        errors=[]
        for i,j,a,b in links:
            ra=np.column_stack((a,np.full(len(a),focal))); rb=np.column_stack((b,np.full(len(b),focal)))
            ra/=np.linalg.norm(ra,axis=1)[:,None]; rb/=np.linalg.norm(rb,axis=1)[:,None]
            errors.append((ra@mats[i].T-rb@mats[j].T).ravel())
        if regularize:
            errors.extend([params[:-1]*0.008,np.array([params[-1]*0.01])])
        return np.concatenate(errors)
    initial=np.zeros(n*3+1)
    before=np.median(np.linalg.norm(residual(initial,False).reshape(-1,3),axis=1))
    progress(f'Refining {len(links)} overlapping pairs...')
    fitted=least_squares(residual,initial,jac_sparsity=pattern.tocsr(),loss='soft_l1',f_scale=.0015,max_nfev=150,ftol=1e-7)
    after=np.median(np.linalg.norm(residual(fitted.x,False).reshape(-1,3),axis=1))
    progress(f'Median alignment error: {math.degrees(before):.3f}° → {math.degrees(after):.3f}°')
    if after>0.005 or after>before*1.05:
        raise RuntimeError('Alignment did not converge sufficiently. No blended output was exported.')
    return Rotation.from_rotvec(fitted.x[:-1].reshape(n,3)).as_matrix() @ base, focal0*math.exp(fitted.x[-1]), {'pairs':len(links),'before_deg':math.degrees(before),'after_deg':math.degrees(after)}
