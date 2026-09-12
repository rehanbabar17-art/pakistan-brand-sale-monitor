FROM python:3.12-slim

WORKDIR /app

COPY web/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p logs state

EXPOSE 8080

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--timeout", "600", "--chdir", "web", "app:app"]
