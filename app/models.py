from sqlalchemy import Column, Integer, String
from .db import Base


class Dog(Base):
    __tablename__ = "dogs"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    breed = Column(String, nullable=True)
    age = Column(Integer, nullable=True)
