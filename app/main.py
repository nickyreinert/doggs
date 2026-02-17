from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.orm import Session
from . import models, schemas
from .db import SessionLocal, init_db

init_db()

app = FastAPI(title="Doggs API")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@app.post("/dogs", response_model=schemas.DogRead)
def create_dog(dog: schemas.DogCreate, db: Session = Depends(get_db)):
    db_dog = models.Dog(name=dog.name, breed=dog.breed, age=dog.age)
    db.add(db_dog)
    db.commit()
    db.refresh(db_dog)
    return db_dog


@app.get("/dogs", response_model=list[schemas.DogRead])
def list_dogs(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    dogs = db.query(models.Dog).offset(skip).limit(limit).all()
    return dogs


@app.get("/dogs/{dog_id}", response_model=schemas.DogRead)
def get_dog(dog_id: int, db: Session = Depends(get_db)):
    dog = db.query(models.Dog).filter(models.Dog.id == dog_id).first()
    if not dog:
        raise HTTPException(status_code=404, detail="Dog not found")
    return dog
