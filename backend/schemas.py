from pydantic import BaseModel
from typing import Optional


class DogBase(BaseModel):
    name: str
    breed: Optional[str] = None
    age: Optional[int] = None


class DogCreate(DogBase):
    pass


class DogRead(DogBase):
    id: int

    class Config:
        orm_mode = True
